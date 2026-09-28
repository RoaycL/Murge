import { execFile } from 'node:child_process'
import { brand } from '@shared/brand'
import type { StartupAdapter } from './service'
import { ElectronStartupAdapter } from './electron-adapter'
export interface ScheduledTaskRunResult {
  stdout: string
  stderr: string
  code: number
}

/** A command runner (defaults to `execFile`); injectable so the adapter is testable. */
export type ScheduledTaskCommandRunner = (
  command: string,
  args: string[]
) => Promise<ScheduledTaskRunResult>

const TASK_NAME = brand.appId
const SCHTASKS_COMMAND = process.platform === 'win32' ? 'schtasks.exe' : 'schtasks'
const REG_COMMAND = process.platform === 'win32' ? 'reg.exe' : 'reg'
const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const LEGACY_RUN_VALUE = `electron.app.${brand.productName}`
const DEFAULT_TIMEOUT_MS = 8000

type ScheduledTaskExecError = Error & {
  code?: string | number | null
  killed?: boolean
}

/** Preserve numeric child exits, but never turn transport failures into success. */
export function scheduledTaskExitCode(error: ScheduledTaskExecError | null): number {
  if (!error) return 0
  if (typeof error.code === 'number') return error.code
  const reason = typeof error.code === 'string'
    ? error.code
    : error.killed
      ? 'ETIMEDOUT'
      : 'EXEC_FAILED'
  throw new Error(`${reason}: ${error.message}`)
}

function defaultRunner(command: string, args: string[]): Promise<ScheduledTaskRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        let code: number
        try {
          code = scheduledTaskExitCode(error as ScheduledTaskExecError | null)
        } catch (transportError) {
          reject(transportError)
          return
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code
        })
      }
    )
  })
}

/** True when the task-level `<Settings><Enabled>` element is `true`. */
export function taskSettingsEnabled(taskXml: string): boolean {
  const settingsIndex = taskXml.indexOf('<Settings>')
  if (settingsIndex === -1) return false
  const match = /<Enabled>(true|false)<\/Enabled>/.exec(taskXml.slice(settingsIndex))
  return match?.[1] === 'true'
}

/**
 * Windows auto-start via a task registered by the elevated installer. The GUI
 * only toggles that task; it never tries to create one without elevation.
 *
 * The Run key remains for installations where task registration or management
 * is denied, and for users who enable auto-start before upgrading the installer.
 *
 * Read and write agree on the same always-`--hidden` argument convention as the
 * Run-key adapter. `rewriteIfEnabled()` only maintains a working registration;
 * task definition and ACL upgrades are the installer's responsibility.
 */
export class ScheduledTaskStartupAdapter implements StartupAdapter {
  readonly supported: boolean
  private readonly legacy: StartupAdapter

  /**
   * The legacy preference provider is retained for source compatibility while
   * every new registration is hidden. A test may inject a runner in place of
   * the real `schtasks` child process, a supported flag to
   * exercise the win32 logic off-Windows, and a legacy adapter in place of the
   * Electron login-item fallback.
   */
  constructor(
    getSilentLaunch: () => boolean = () => false,
    private readonly runner: ScheduledTaskCommandRunner = defaultRunner,
    options?: { supported?: boolean; legacy?: StartupAdapter }
  ) {
    this.supported = options?.supported ?? process.platform === 'win32'
    this.legacy = options?.legacy ?? new ElectronStartupAdapter(getSilentLaunch)
  }

  async read(): Promise<boolean> {
    if (!this.supported) return false
    const taskXml = await this.queryTaskXml()
    if (taskXml !== null && taskSettingsEnabled(taskXml)) return true
    // A Run entry can be intentional fallback when changing a preinstalled
    // disabled task was denied by Windows.
    if (await this.hasStableRunEntry()) return true
    if (await this.hasLegacyRunEntry()) return true
    return (await this.legacy.readRegistered?.()) ?? (await this.legacy.read())
  }

  async write(enabled: boolean): Promise<void> {
    if (!this.supported) return
    if (!enabled) {
      await this.disable()
      return
    }
    const taskXml = await this.queryTaskXml()
    if (taskXml !== null) {
      if (taskSettingsEnabled(taskXml)) {
        await this.clearRunFallbacks()
        return
      }
      const result = await this.runner(SCHTASKS_COMMAND, ['/change', '/tn', TASK_NAME, '/enable'])
        .catch(() => null)
      if (result?.code === 0 && taskSettingsEnabled(await this.queryTaskXml() ?? '')) {
        await this.clearRunFallbacks()
        return
      }
    }
    // An installer has not registered a task yet, or changing it was denied.
    // Preserve a functional auto-start without spawning a UAC prompt here.
    if (!(await this.writeStableRunEntry())) await this.legacy.write(true)
  }

  async rewriteIfEnabled(): Promise<void> {
    if (!this.supported) return
    const taskXml = await this.queryTaskXml()
    if (taskXml !== null) {
      if (taskSettingsEnabled(taskXml)) await this.clearRunFallbacks()
      return
    }
    // No task: keep one canonical Run value until an elevated installer can
    // create the task, including after a legacy Electron registration.
    const stableRegistered = await this.hasStableRunEntry()
    const legacyRegistered = stableRegistered || await this.hasLegacyRunEntry() ||
      ((await this.legacy.readRegistered?.()) ?? (await this.legacy.read()))
    if (!legacyRegistered) return
    if (!stableRegistered) await this.writeStableRunEntry()
  }

  private async disable(): Promise<void> {
    const taskXml = await this.queryTaskXml()
    if (taskXml !== null && taskSettingsEnabled(taskXml)) {
      const result = await this.runner(SCHTASKS_COMMAND, ['/change', '/tn', TASK_NAME, '/disable'])
      const updated = result.code === 0 ? await this.queryTaskXml() : null
      if (updated === null || taskSettingsEnabled(updated)) {
        throw new Error('无法禁用开机启动计划任务，请检查任务权限')
      }
    }
    await this.clearRunFallbacks()
  }

  private runValue(): string {
    const executable = `"${process.execPath}"`
    return `${executable} --hidden`
  }

  private async hasStableRunEntry(): Promise<boolean> {
    try {
      const result = await this.runner(REG_COMMAND, ['query', RUN_KEY_PATH, '/v', TASK_NAME])
      if (result.code !== 0) return false
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
      return output.includes(TASK_NAME.toLowerCase()) && output.includes(process.execPath.toLowerCase())
    } catch {
      return false
    }
  }

  private async hasLegacyRunEntry(): Promise<boolean> {
    try {
      const result = await this.runner(REG_COMMAND, ['query', RUN_KEY_PATH, '/v', LEGACY_RUN_VALUE])
      if (result.code !== 0) return false
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
      return output.includes(LEGACY_RUN_VALUE.toLowerCase()) && output.includes(process.execPath.toLowerCase())
    } catch {
      return false
    }
  }

  private async writeStableRunEntry(): Promise<boolean> {
    try {
      const args = [
        'add', RUN_KEY_PATH, '/v', TASK_NAME, '/t', 'REG_SZ', '/d', this.runValue(), '/f'
      ]
      // Prove direct registry writes work before touching a working legacy
      // entry. Then retire every historical name and write the one canonical
      // value again because Electron's cleanup also removes the app-id value.
      const probe = await this.runner(REG_COMMAND, args)
      if (probe.code !== 0) return false
      await this.legacy.write(false).catch(() => undefined)
      await this.clearLegacyRunEntry()
      const result = await this.runner(REG_COMMAND, args)
      if (result.code === 0 && await this.hasStableRunEntry()) return true
      await this.legacy.write(true).catch(() => undefined)
      return false
    } catch {
      return false
    }
  }

  private async clearRunFallbacks(): Promise<void> {
    await this.runner(REG_COMMAND, ['delete', RUN_KEY_PATH, '/v', TASK_NAME, '/f']).catch(() => undefined)
    await this.clearLegacyRunEntry()
    await this.legacy.write(false).catch(() => undefined)
  }

  private async clearLegacyRunEntry(): Promise<void> {
    if (!await this.hasLegacyRunEntry()) return
    await this.runner(REG_COMMAND, ['delete', RUN_KEY_PATH, '/v', LEGACY_RUN_VALUE, '/f']).catch(() => undefined)
  }

  /** The registered task definition, or null when the task does not exist. */
  private async queryTaskXml(): Promise<string | null> {
    try {
      const result = await this.runner(SCHTASKS_COMMAND, ['/query', '/tn', TASK_NAME, '/xml'])
      if (result.code !== 0) return null
      return result.stdout.includes('<?xml') ? result.stdout : null
    } catch {
      // schtasks exits non-zero with "The system cannot find the file
      // specified" when the task is absent — indistinguishable from a transport
      // failure here, and both mean "not registered via a task".
      return null
    }
  }
}

/** The deterministic task name (`schtasks /tn` value), exported for tests. */
export const SCHEDULED_TASK_NAME = TASK_NAME
/** The legacy fallback registration key, exported for tests. */
export const SCHEDULED_TASK_RUN_KEY = RUN_KEY_PATH
