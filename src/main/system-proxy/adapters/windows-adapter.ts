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
  regAddDwordArgs,
  regAddStringArgs,
  regDeleteValueArgs,
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
      // `reg query` returns a non-zero exit (code 1) when the value is absent —
      // that is a *normal* "missing value" signal, so surface it via `code` rather
      // than rejecting. Real transport errors are `code` strings, which reject.
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

  private async readValue(valueName: string): Promise<RegistryValue> {
    const result = await this.run(REG_COMMAND, regQueryValueArgs(valueName))
    if (result.code !== 0) {
      return { exists: false, type: 'none', value: null }
    }
    return parseRegQueryValue(result.stdout)
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
    await this.run(REG_COMMAND, regAddDwordArgs(PROXY_ENABLE_VALUE, 1))
    await this.run(REG_COMMAND, regAddStringArgs(PROXY_SERVER_VALUE, written.proxyServer.value))
    await this.run(REG_COMMAND, regAddStringArgs(PROXY_OVERRIDE_VALUE, written.proxyOverride.value as string))
  }

  async restore(previous: SystemProxyRegistryState): Promise<void> {
    await this.restoreValue(PROXY_ENABLE_VALUE, previous.proxyEnable)
    await this.restoreValue(PROXY_SERVER_VALUE, previous.proxyServer)
    await this.restoreValue(PROXY_OVERRIDE_VALUE, previous.proxyOverride)
  }

  private async restoreValue(valueName: string, value: RegistryValue): Promise<void> {
    if (!value.exists) {
      // The value did not exist before the app enabled the proxy — delete it so the
      // user's registry is byte-for-byte back to its original state.
      await this.run(REG_COMMAND, regDeleteValueArgs(valueName))
      return
    }
    if (value.type === 'dword' && typeof value.value === 'number') {
      await this.run(REG_COMMAND, regAddDwordArgs(valueName, value.value))
      return
    }
    if (typeof value.value === 'string') {
      await this.run(REG_COMMAND, regAddStringArgs(valueName, value.value))
      return
    }
    // A type we cannot faithfully re-write (e.g. REG_BINARY) is surfaced rather
    // than silently dropped.
    throw new ProtocolError(
      ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED,
      `系统代理项 ${valueName} 的类型无法还原（${value.type}）`
    )
  }

  async refresh(): Promise<void> {
    await this.run(POWERSHELL_COMMAND, ['-NoProfile', '-NonInteractive', '-Command', buildWinInetRefreshScript()])
  }
}
