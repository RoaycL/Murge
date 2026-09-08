import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

/**
 * Logon-trigger task XML. Deliberately different from an HKCU Run entry:
 *
 * - `Delay PT3S` starts the app a few seconds after logon, outside the worst of
 *   the login disk/CPU storm (clash-party parity).
 * - `Priority 3` schedules the process above the default background class.
 * - `LeastPrivilege` needs no elevation: the kernel's privileges live in the
 *   LocalSystem TUN service, not in the GUI process.
 * - `ExecutionTimeLimit PT0S` stops Windows from killing the app after a
 *   default 72h task limit.
 */
export function buildTaskXml(executablePath: string, args: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT3S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>3</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${escapeXml(executablePath)}"</Command>
      ${args.length > 0 ? `<Arguments>${escapeXml(args.join(' '))}</Arguments>` : ''}
    </Exec>
  </Actions>
</Task>
`
}

/** True when the task-level `<Settings><Enabled>` element is `true`. */
export function taskSettingsEnabled(taskXml: string): boolean {
  const settingsIndex = taskXml.indexOf('<Settings>')
  if (settingsIndex === -1) return false
  const match = /<Enabled>(true|false)<\/Enabled>/.exec(taskXml.slice(settingsIndex))
  return match?.[1] === 'true'
}

/** Task arguments as registered (`--hidden` for silent launches, none otherwise). */
export function taskArguments(taskXml: string): string[] {
  const match = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(taskXml)
  const raw = match?.[1] ?? ''
  if (raw.trim().length === 0) return []
  // Compare against the unescaped form: a compare against raw XML entities
  // would never match and re-create the task on every startup.
  return unescapeXml(raw).trim().split(/\s+/)
}

/**
 * Windows auto-start via a per-user Scheduled Task (schtasks), with the legacy
 * HKCU Run-key registration kept as a fallback.
 *
 * Why a task instead of Electron's login item (the old default): the task can
 * carry a logon delay and a process priority, which makes login launches land
 * after the post-logon resource storm. The Run key remains for machines where
 * scheduled-task creation is denied (enterprise policy, stripped-down SKUs) so
 * auto-start degrades to exactly the previous behaviour instead of failing.
 *
 * Read and write agree on the same `--hidden` argument convention as the
 * Run-key adapter: silent launches register the flag, loud launches register
 * none. `read()` is argument-insensitive (it reports what is registered);
 * `rewriteIfEnabled()` rewrites the stored arguments when the persisted
 * silent-launch preference has moved, and migrates a legacy Run-key-only
 * registration to the task form.
 */
export class ScheduledTaskStartupAdapter implements StartupAdapter {
  readonly supported: boolean
  private readonly legacy: StartupAdapter

  /**
   * Sync provider for the persisted silent-launch preference. A test may inject
   * a runner in place of the real `schtasks` child process, a supported flag to
   * exercise the win32 logic off-Windows, and a legacy adapter in place of the
   * Electron login-item fallback.
   */
  constructor(
    private readonly getSilentLaunch: () => boolean = () => false,
    private readonly runner: ScheduledTaskCommandRunner = defaultRunner,
    options?: { supported?: boolean; legacy?: StartupAdapter }
  ) {
    this.supported = options?.supported ?? process.platform === 'win32'
    this.legacy = options?.legacy ?? new ElectronStartupAdapter(getSilentLaunch)
  }

  async read(): Promise<boolean> {
    if (!this.supported) return false
    // A present task owns the registration: a task disabled in the Task
    // Scheduler UI reports off even if a stale legacy entry lingers, matching
    // what the user chose there.
    const taskXml = await this.queryTaskXml()
    if (taskXml !== null) return taskSettingsEnabled(taskXml)
    if (await this.hasStableRunEntry()) return true
    return (await this.legacy.readRegistered?.()) ?? (await this.legacy.read())
  }

  async write(enabled: boolean): Promise<void> {
    if (!this.supported) return
    if (!enabled) {
      await this.disable()
      return
    }
    const created = await this.tryCreateTask()
    if (created) {
      // The task now owns the registration; drop any legacy Run-key entry so
      // the app is not started twice at logon.
      await this.clearRunFallbacks()
      return
    }
    // Scheduled-task creation was denied. Own one deterministic Run value and
    // verify it directly instead of relying on Electron's argument-sensitive
    // login-item lookup (which can report false for an entry it just wrote).
    if (!(await this.writeStableRunEntry())) await this.legacy.write(true)
  }

  async rewriteIfEnabled(): Promise<void> {
    if (!this.supported) return
    const taskXml = await this.queryTaskXml()
    if (taskXml !== null) {
      // A present task owns the registration. A task disabled in the Task
      // Scheduler UI means the user turned auto-start off there — leave it.
      if (!taskSettingsEnabled(taskXml)) return
      const currentArgs = taskArguments(taskXml)
      const desiredArgs = this.loginArgs()
      if (currentArgs.length === desiredArgs.length && currentArgs.every((a, i) => a === desiredArgs[i])) {
        // Already current; retire a lingering legacy Run-key entry (e.g. the
        // fallback engaged once) so the app is not started twice at logon.
        await this.clearRunFallbacks()
        return
      }
      // Arguments moved (silent-launch toggle): recreate with desired args.
      const created = await this.tryCreateTask()
      if (!created) throw new Error('无法更新开机启动计划任务，已保留原有注册')
      // A previous fallback may coexist with the stale task. Once the task has
      // been replaced successfully it owns registration again.
      await this.clearRunFallbacks()
      return
    }
    // Legacy-only registration (v0.9.x Run-key users): migrate to the task so
    // future logins get the delayed, prioritised launch. The existence check
    // MUST be argument-insensitive — an argument-sensitive read cannot see a
    // Run-key entry written with a stale `--hidden` value, which would silently
    // skip its migration. A failed create keeps the Run key untouched —
    // degrades to today's behaviour.
    const stableRegistered = await this.hasStableRunEntry()
    const legacyRegistered = stableRegistered || ((await this.legacy.readRegistered?.()) ?? (await this.legacy.read()))
    if (!legacyRegistered) return
    const created = await this.tryCreateTask()
    if (created) await this.clearRunFallbacks()
    else if (!stableRegistered) await this.writeStableRunEntry()
  }

  private loginArgs(): string[] {
    return this.getSilentLaunch() ? ['--hidden'] : []
  }

  private async disable(): Promise<void> {
    await this.runner(SCHTASKS_COMMAND, ['/delete', '/tn', TASK_NAME, '/f']).catch(() => undefined)
    await this.clearRunFallbacks()
  }

  private runValue(): string {
    const executable = `"${process.execPath}"`
    return this.getSilentLaunch() ? `${executable} --hidden` : executable
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
    await this.legacy.write(false).catch(() => undefined)
  }

  /** Create (or replace) the task. Returns false when creation was denied. */
  private async tryCreateTask(): Promise<boolean> {
    let stagingDir: string | null = null
    try {
      stagingDir = await mkdtemp(join(tmpdir(), 'murge-startup-'))
      const taskFile = join(stagingDir, 'task.xml')
      // The XML declares encoding="UTF-16" and MUST be written with a UTF-16
      // BOM: without it schtasks parses the file as ANSI and rejects the task
      // definition (observed in the reference implementation, which prepends
      // \ufeff for exactly this reason).
      await writeFile(taskFile, `\ufeff${buildTaskXml(process.execPath, this.loginArgs())}`, 'utf16le')
      const result = await this.runner(SCHTASKS_COMMAND, ['/create', '/tn', TASK_NAME, '/xml', taskFile, '/f'])
      // A resolved runner may still carry the child's non-zero exit (policy
      // denial, XML rejected, ...) — only a zero exit registers the task.
      return result.code === 0
    } catch {
      return false
    } finally {
      if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    }
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
