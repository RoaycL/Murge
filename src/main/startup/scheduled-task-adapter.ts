import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, unlink } from 'node:fs/promises'
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
const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const DEFAULT_TIMEOUT_MS = 8000

function defaultRunner(command: string, args: string[]): Promise<ScheduledTaskRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (error as NodeJS.ErrnoException & { code?: number }).code : 0
        // A string `code` (ENOENT, ETIMEDOUT, ...) is a real transport failure and
        // must reject; a numeric code is the child's exit status.
        if (typeof error?.code === 'string') {
          reject(new Error(`${error.code}: ${error.message}`))
          return
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: typeof code === 'number' ? code : 0
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
      <Arguments>${escapeXml(args.join(' '))}</Arguments>
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
  return raw.trim().length === 0 ? [] : raw.trim().split(/\s+/)
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
    try {
      const taskXml = await this.queryTaskXml()
      if (taskXml !== null && taskSettingsEnabled(taskXml)) return true
    } catch {
      // Fall through to the legacy registration below.
    }
    return this.legacy.read()
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
      await this.legacy.write(false).catch(() => undefined)
      return
    }
    // Scheduled-task creation was denied: fall back to the previous mechanism.
    await this.legacy.write(true)
  }

  async rewriteIfEnabled(): Promise<void> {
    if (!this.supported) return
    const registered = await this.read()
    if (!registered) return
    const desiredArgs = this.loginArgs()
    let taskXml: string | null = null
    try {
      taskXml = await this.queryTaskXml()
    } catch {
      taskXml = null
    }
    if (taskXml !== null) {
      const currentArgs = taskArguments(taskXml)
      if (
        taskSettingsEnabled(taskXml) &&
        currentArgs.length === desiredArgs.length &&
        currentArgs.every((arg, index) => arg === desiredArgs[index])
      ) {
        return
      }
      // Arguments moved (silent-launch toggle) or the task was disabled in the
      // Task Scheduler UI: recreate it with the desired definition.
      await this.tryCreateTask()
      return
    }
    // Legacy-only registration (v0.9.x Run-key users): migrate to the task so
    // future logins get the delayed, prioritised launch. A failed create keeps
    // the Run key untouched — degrades to today's behaviour.
    const created = await this.tryCreateTask()
    if (created) await this.legacy.write(false).catch(() => undefined)
  }

  private loginArgs(): string[] {
    return this.getSilentLaunch() ? ['--hidden'] : []
  }

  private async disable(): Promise<void> {
    await this.runner(SCHTASKS_COMMAND, ['/delete', '/tn', TASK_NAME, '/f']).catch(() => undefined)
    await this.legacy.write(false).catch(() => undefined)
  }

  /** Create (or replace) the task. Returns false when creation was denied. */
  private async tryCreateTask(): Promise<boolean> {
    const stagingDir = await mkdtemp(join(tmpdir(), 'murge-startup-'))
    const taskFile = join(stagingDir, 'task.xml')
    try {
      await writeFile(taskFile, buildTaskXml(process.execPath, this.loginArgs()), 'utf16le')
      const result = await this.runner(SCHTASKS_COMMAND, ['/create', '/tn', TASK_NAME, '/xml', taskFile, '/f'])
      // A resolved runner may still carry the child's non-zero exit (policy
      // denial, XML rejected, ...) — only a zero exit registers the task.
      return result.code === 0
    } catch {
      return false
    } finally {
      await unlink(taskFile).catch(() => undefined)
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
