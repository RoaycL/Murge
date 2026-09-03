import { execFile } from 'node:child_process'
import { ProtocolError, ProtocolErrorCode } from '../../../shared/protocol-errors'
import type {
  RegistryValue,
  SystemProxyAdapter,
  SystemProxyRegistryState,
  SystemProxyWrittenState
} from '../types'
import {
  PROXY_ENABLE_VALUE,
  PROXY_OVERRIDE_VALUE,
  PROXY_SERVER_VALUE,
  buildRegistryReadScript,
  buildWinInetRefreshScript,
  coerceRegistrySnapshot,
  regAddArgsFor,
  regAddDwordArgs,
  regAddStringArgs
} from './windows-helpers'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

/** A command runner (defaults to `execFile`); injectable so the adapter is testable. */
export type CommandRunner = (command: string, args: string[]) => Promise<RunResult>

const REG_COMMAND = process.platform === 'win32' ? 'reg.exe' : 'reg'
const POWERSHELL_COMMAND = 'powershell'
const DEFAULT_TIMEOUT_MS = 5000
const REGISTRY_READ_ATTEMPTS = 3
const REGISTRY_READ_RETRY_MS = 75

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

function defaultRunner(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (error as NodeJS.ErrnoException & { code?: number }).code : 0
      // Real transport errors (command not found / timeout) are carried as a
      // string `code` by Node; those MUST reject so the caller sees a typed error
      // instead of a phantom "value absent".
      if (typeof error?.code === 'string') {
        reject(new Error(`${error.code}: ${error.message}`))
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: typeof code === 'number' ? code : 0 })
    })
  })
}

/**
 * Windows system-proxy adapter. Owns the three HKCU Internet Settings values on
 * the current user via `reg.exe`, then tells WinINet to re-read them.
 *
 * This adapter is only ever instantiated on `win32` production builds (see
 * `src/main/index.ts`); on every other platform a fail-closed adapter is used.
 */
export class WindowsSystemProxyAdapter implements SystemProxyAdapter {
  readonly platform = 'win32'
  readonly supported = true

  constructor(private readonly run: CommandRunner = defaultRunner) {}

  /** Run a command and surface a non-zero exit / transport error as a typed error. */
  private async runChecked(
    command: string,
    args: string[],
    failCode: ProtocolErrorCode,
    message: string
  ): Promise<RunResult> {
    let result: RunResult
    try {
      result = await this.run(command, args)
    } catch (error) {
      // Transport failure (e.g. reg.exe / powershell not on PATH, timeout).
      throw new ProtocolError(failCode, `${message}：${(error as Error).message}`)
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
      throw new ProtocolError(failCode, `${message}：${detail}`)
    }
    return result
  }

  /**
   * Read all three HKCU Internet Settings values in ONE PowerShell/.NET call.
   *
   * The .NET reader returns the exact stored string, the exact registry type
   * (REG_SZ vs REG_EXPAND_SZ vs REG_BINARY) and never expands environment names,
   * so a REG_SZ carrying leading/trailing spaces or a REG_EXPAND_SZ with `%VAR%`
   * round-trips faithfully (P1-2). The output is strictly coerced (P1-1): a
   * malformed value is a read failure, never a phantom `0` / absent.
   */
  private async readRegistrySnapshot(): Promise<Record<'ProxyEnable' | 'ProxyServer' | 'ProxyOverride', RegistryValue>> {
    const diagnostics: string[] = []
    for (let attempt = 1; attempt <= REGISTRY_READ_ATTEMPTS; attempt += 1) {
      const result = await this.runChecked(
        POWERSHELL_COMMAND,
        ['-NoProfile', '-NonInteractive', '-Command', buildRegistryReadScript()],
        ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED,
        '读取系统代理注册表值失败'
      )
      try {
        return coerceRegistrySnapshot(result.stdout)
      } catch (error) {
        // Hosted Windows runners have occasionally returned exit 0 with empty or
        // truncated stdout while PowerShell itself was still draining. Retry the
        // complete, side-effect-free snapshot command; malformed data never gets
        // accepted and the final failure remains fail-closed.
        const stderr = result.stderr.trim()
        diagnostics.push(
          `attempt=${attempt}, stdoutBytes=${Buffer.byteLength(result.stdout)}, stderrBytes=${Buffer.byteLength(result.stderr)}` +
            (stderr ? `, stderr=${stderr.slice(0, 160)}` : '')
        )
        if (attempt < REGISTRY_READ_ATTEMPTS) {
          await delay(REGISTRY_READ_RETRY_MS * attempt)
          continue
        }
        throw new ProtocolError(
          ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED,
          `解析系统代理注册表快照失败（已重试 ${REGISTRY_READ_ATTEMPTS} 次）：${(error as Error).message}；${diagnostics.join('；')}`
        )
      }
    }
    throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, '解析系统代理注册表快照失败')
  }

  async readValue(valueName: string): Promise<RegistryValue> {
    const snapshot = await this.readRegistrySnapshot()
    switch (valueName) {
      case PROXY_ENABLE_VALUE:
        return snapshot.ProxyEnable
      case PROXY_SERVER_VALUE:
        return snapshot.ProxyServer
      case PROXY_OVERRIDE_VALUE:
        return snapshot.ProxyOverride
      default:
        throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, `未知的注册表项 ${valueName}`)
    }
  }

  async read(): Promise<SystemProxyRegistryState> {
    const snapshot = await this.readRegistrySnapshot()
    return {
      proxyEnable: snapshot.ProxyEnable,
      proxyServer: snapshot.ProxyServer,
      proxyOverride: snapshot.ProxyOverride
    }
  }

  async apply(written: SystemProxyWrittenState): Promise<void> {
    if (!written.proxyServer.exists || typeof written.proxyServer.value !== 'string') {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, '系统代理目标值无效')
    }
    await this.runChecked(REG_COMMAND, regAddDwordArgs(PROXY_ENABLE_VALUE, 1), ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, '写入 ProxyEnable 失败')
    await this.runChecked(REG_COMMAND, regAddStringArgs(PROXY_SERVER_VALUE, written.proxyServer.value), ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, '写入 ProxyServer 失败')
    await this.runChecked(REG_COMMAND, regAddStringArgs(PROXY_OVERRIDE_VALUE, written.proxyOverride.value as string), ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, '写入 ProxyOverride 失败')
  }

  async restore(previous: SystemProxyRegistryState): Promise<void> {
    await this.restoreValue(PROXY_ENABLE_VALUE, previous.proxyEnable)
    await this.restoreValue(PROXY_SERVER_VALUE, previous.proxyServer)
    await this.restoreValue(PROXY_OVERRIDE_VALUE, previous.proxyOverride)
  }

  private async restoreValue(valueName: string, value: RegistryValue): Promise<void> {
    const args = regAddArgsFor(valueName, value)
    await this.runChecked(REG_COMMAND, args, ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, `还原注册表项 ${valueName} 失败`)
  }

  async refresh(): Promise<void> {
    // The script exits non-zero (or throws) when either InternetSetOption call
    // failed, so a WinINet failure is surfaced and can trigger a rollback.
    await this.runChecked(
      POWERSHELL_COMMAND,
      ['-NoProfile', '-NonInteractive', '-Command', buildWinInetRefreshScript()],
      ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED,
      '刷新 WinINet 代理设置失败'
    )
  }
}
