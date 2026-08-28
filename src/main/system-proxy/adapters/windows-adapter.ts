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
  buildWinInetRefreshScript,
  parseRegQueryValue,
  regAddArgsFor,
  regAddDwordArgs,
  regAddStringArgs,
  regQueryValueArgs
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

/** Whether the output signals a registry access/authorization failure (never "absent"). */
function looksLikeAccessDenied(result: RunResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
  return /access\s+is\s+denied|access.*denied|denied|拒绝访问|无法打开|permission denied/i.test(text)
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

  async readValue(valueName: string): Promise<RegistryValue> {
    let result: RunResult
    try {
      result = await this.run(REG_COMMAND, regQueryValueArgs(valueName))
    } catch (error) {
      // reg.exe could not be executed at all — that is an error, not "absent".
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, `无法执行 reg.exe 读取注册表项 ${valueName}：${(error as Error).message}`)
    }
    if (result.code === 0) {
      return parseRegQueryValue(result.stdout, valueName)
    }
    if (looksLikeAccessDenied(result)) {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, `读取注册表项 ${valueName} 被拒绝（权限不足）`)
    }
    // `reg query` signals a missing value with exit code 1 — that is the only
    // outcome the controller treats as "value absent". Any other non-zero code
    // (e.g. access denied on another hive) is an error, never a phantom absence.
    if (result.code === 1) {
      return { exists: false, type: 'none', value: null }
    }
    throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, `读取注册表项 ${valueName} 失败 (${result.code})`)
  }

  async read(): Promise<SystemProxyRegistryState> {
    const [proxyEnable, proxyServer, proxyOverride] = await Promise.all([
      this.readValue(PROXY_ENABLE_VALUE),
      this.readValue(PROXY_SERVER_VALUE),
      this.readValue(PROXY_OVERRIDE_VALUE)
    ])
    return { proxyEnable, proxyServer, proxyOverride }
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
