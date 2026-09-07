import { describe, expect, it, vi } from 'vitest'
import {
  ScheduledTaskStartupAdapter,
  buildTaskXml,
  taskArguments,
  taskSettingsEnabled,
  SCHEDULED_TASK_NAME,
  SCHEDULED_TASK_RUN_KEY
} from '../src/main/startup/scheduled-task-adapter'
import type { StartupAdapter } from '../src/main/startup/service'
import { StartupService } from '../src/main/startup/service'

// The default legacy fallback imports `electron`; stub the surface it uses so
// the module imports cleanly outside Electron.
vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => undefined
  }
}))

interface Call {
  command: string
  args: string[]
}

type Responder = (call: Call) => { stdout: string; stderr: string; code: number }

const OK: Responder = () => ({ stdout: 'SUCCESS', stderr: '', code: 0 })
const TASK_MISSING: Responder = () => ({ stdout: '', stderr: 'cannot find', code: 1 })

/** Records every legacy write/read so fallback and migration paths are observable. */
function fakeLegacy(readValue = false): StartupAdapter & { writes: boolean[]; setRead(v: boolean): void } {
  const state = { value: readValue }
  const thisWrites: boolean[] = []
  return {
    supported: true,
    writes: thisWrites,
    read: async () => state.value,
    write: async (enabled: boolean) => {
      state.value = enabled
      thisWrites.push(enabled)
    },
    setRead(v: boolean) {
      state.value = v
    },
    async rewriteIfEnabled() {
      // Match the real contract: rewrite only when registered.
      if (state.value) await this.write(true)
    }
  }
}

function makeAdapter(
  responder: Responder,
  opts: { silentLaunch?: boolean; legacyRead?: boolean } = {}
): ScheduledTaskStartupAdapter & { calls: Call[]; legacy: ReturnType<typeof fakeLegacy> } {
  const calls: Call[] = []
  const legacy = fakeLegacy(opts.legacyRead ?? false)
  const adapter = new ScheduledTaskStartupAdapter(
    () => opts.silentLaunch ?? false,
    async (command, args) => {
      const call = { command, args }
      calls.push(call)
      return responder(call)
    },
    { supported: true, legacy }
  ) as ScheduledTaskStartupAdapter & { calls: Call[]; legacy: ReturnType<typeof fakeLegacy> }
  adapter.calls = calls
  adapter.legacy = legacy
  return adapter
}

function taskCreateCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.args[0] === '/create')
}

function taskXmlWithArgs(args: string[], enabled = true): string {
  return buildTaskXml('C:\\app\\client.exe', args).replace(
    '<Enabled>true</Enabled>\n    <Hidden>',
    `<Enabled>${enabled}</Enabled>\n    <Hidden>`
  )
}

describe('task XML', () => {
  it('uses a delayed logon trigger with least privilege and no time limit', () => {
    const xml = buildTaskXml('C:\\Program Files\\Client\\client.exe', [])
    expect(xml).toContain('<LogonTrigger>')
    expect(xml).toContain('<Delay>PT3S</Delay>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<Priority>3</Priority>')
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
  })

  it('escapes XML-special characters in the command and arguments', () => {
    const xml = buildTaskXml('C:\\dir&More\\app<1>.exe', ['--hidden'])
    expect(xml).toContain('C:\\dir&amp;More\\app&lt;1&gt;.exe')
    expect(xml).toContain('<Arguments>--hidden</Arguments>')
  })

  it('carries --hidden for silent launches and no args otherwise', () => {
    expect(taskArguments(buildTaskXml('C:\\a.exe', ['--hidden']))).toEqual(['--hidden'])
    expect(taskArguments(buildTaskXml('C:\\a.exe', []))).toEqual([])
  })

  it('reads the task-level enabled flag from the Settings block', () => {
    expect(taskSettingsEnabled(taskXmlWithArgs([], true))).toBe(true)
    expect(taskSettingsEnabled(taskXmlWithArgs([], false))).toBe(false)
  })
})

describe('ScheduledTaskStartupAdapter — enable', () => {
  it('creates the logon task named after the appId', async () => {
    const adapter = makeAdapter(OK)
    await adapter.write(true)
    const create = taskCreateCalls(adapter.calls)
    expect(create).toHaveLength(1)
    expect(create[0]!.command).toContain('schtasks')
    expect(create[0]!.args.slice(0, 3)).toEqual(['/create', '/tn', SCHEDULED_TASK_NAME])
    expect(create[0]!.args).toContain('/xml')
    expect(create[0]!.args).toContain('/f')
  })

  it('writes --hidden arguments when silent launch is on', async () => {
    const adapter = makeAdapter(OK, { silentLaunch: true })
    await adapter.write(true)
    expect(taskCreateCalls(adapter.calls)).toHaveLength(1)
  })

  it('clears the legacy Run key once the task owns the registration', async () => {
    const adapter = makeAdapter(OK, { legacyRead: true })
    await adapter.write(true)
    expect(adapter.legacy.writes).toEqual([false])
  })

  it('falls back to the legacy Run key when task creation is denied', async () => {
    const adapter = makeAdapter(TASK_MISSING)
    await adapter.write(true)
    expect(taskCreateCalls(adapter.calls)).toHaveLength(1)
    expect(adapter.legacy.writes).toEqual([true])
  })
})

describe('ScheduledTaskStartupAdapter — disable', () => {
  it('deletes the task and clears the legacy registration', async () => {
    const adapter = makeAdapter(OK)
    await adapter.write(false)
    const remove = adapter.calls.filter((c) => c.args[0] === '/delete')
    expect(remove).toHaveLength(1)
    expect(remove[0]!.args.slice(0, 3)).toEqual(['/delete', '/tn', SCHEDULED_TASK_NAME])
    expect(adapter.legacy.writes).toEqual([false])
  })

  it('succeeds when neither registration exists', async () => {
    const adapter = makeAdapter(TASK_MISSING)
    await adapter.write(false)
    expect(adapter.legacy.writes).toEqual([false])
  })
})

describe('ScheduledTaskStartupAdapter — read', () => {
  it('reports an enabled task without consulting the legacy key', async () => {
    const adapter = makeAdapter((call) =>
      call.args[0] === '/query' ? { stdout: taskXmlWithArgs([]), stderr: '', code: 0 } : OK()
    )
    expect(await adapter.read()).toBe(true)
    expect(adapter.legacy.writes).toEqual([])
  })

  it('ignores a task that is disabled in the Task Scheduler UI and consults the legacy key', async () => {
    const adapter = makeAdapter(
      (call) => (call.args[0] === '/query' ? { stdout: taskXmlWithArgs([], false), stderr: '', code: 0 } : OK()),
      { legacyRead: true }
    )
    expect(await adapter.read()).toBe(true)
  })

  it('falls through to the legacy registration when the task is absent', async () => {
    const adapter = makeAdapter(TASK_MISSING, { legacyRead: true })
    expect(await adapter.read()).toBe(true)
    adapter.legacy.setRead(false)
    expect(await adapter.read()).toBe(false)
  })

  it('treats a query transport failure as not-task-registered', async () => {
    const adapter = makeAdapter(() => {
      throw new Error('ENOENT: schtasks')
    })
    expect(await adapter.read()).toBe(false)
  })
})

describe('ScheduledTaskStartupAdapter — rewrite', () => {
  it('recreates the task when registered arguments differ (silent-launch toggle)', async () => {
    const adapter = makeAdapter(
      (call) => (call.args[0] === '/query' ? { stdout: taskXmlWithArgs([]), stderr: '', code: 0 } : OK()),
      { silentLaunch: true }
    )
    await adapter.rewriteIfEnabled()
    expect(taskCreateCalls(adapter.calls)).toHaveLength(1)
  })

  it('leaves a matching enabled task untouched', async () => {
    const adapter = makeAdapter((call) =>
      call.args[0] === '/query' ? { stdout: taskXmlWithArgs([]), stderr: '', code: 0 } : OK()
    )
    await adapter.rewriteIfEnabled()
    expect(taskCreateCalls(adapter.calls)).toHaveLength(0)
  })

  it('treats a task disabled in the Task Scheduler UI as unregistered (no rewrite)', async () => {
    // A disabled task reads as autostart-off, matching what the user chose in
    // the Task Scheduler; the toggle re-enables via write(true) when wanted.
    const adapter = makeAdapter(
      (call) => (call.args[0] === '/query' ? { stdout: taskXmlWithArgs([], false), stderr: '', code: 0 } : OK())
    )
    expect(await adapter.read()).toBe(false)
    await adapter.rewriteIfEnabled()
    expect(taskCreateCalls(adapter.calls)).toHaveLength(0)
  })

  it('migrates a legacy-only registration to the task and retires the Run key', async () => {
    const adapter = makeAdapter(
      (call) => (call.args[0] === '/query' ? TASK_MISSING(call) : OK()),
      { legacyRead: true }
    )
    await adapter.rewriteIfEnabled()
    expect(taskCreateCalls(adapter.calls)).toHaveLength(1)
    expect(adapter.legacy.writes).toEqual([false])
  })

  it('keeps the legacy registration when migration creation fails', async () => {
    const adapter = makeAdapter(
      (call) => (call.args[0] === '/create' ? { stdout: '', stderr: 'denied', code: 1 } : TASK_MISSING(call)),
      { legacyRead: true }
    )
    await adapter.rewriteIfEnabled()
    expect(adapter.legacy.writes).toEqual([])
  })

  it('does nothing when nothing is registered', async () => {
    const adapter = makeAdapter(TASK_MISSING)
    await adapter.rewriteIfEnabled()
    expect(taskCreateCalls(adapter.calls)).toHaveLength(0)
    expect(adapter.calls.some((c) => c.args[0] === '/delete')).toBe(false)
    expect(adapter.legacy.writes).toEqual([])
  })
})

describe('ScheduledTaskStartupAdapter through StartupService', () => {
  it('enable → confirmation read → reported enabled', async () => {
    const adapter = makeAdapter((call) =>
      call.args[0] === '/query' ? { stdout: taskXmlWithArgs(['--hidden']), stderr: '', code: 0 } : OK(),
      { silentLaunch: true }
    )
    const status = await new StartupService(adapter).setEnabled(true)
    expect(status).toMatchObject({ supported: true, enabled: true, phase: 'idle' })
  })

  it('disable → confirmation read through the legacy fallback → reported disabled', async () => {
    const adapter = makeAdapter(TASK_MISSING)
    const status = await new StartupService(adapter).setEnabled(false)
    expect(status).toMatchObject({ supported: true, enabled: false, phase: 'idle' })
  })
})

describe('registration constants', () => {
  it('names the task after the brand-stable appId', () => {
    expect(SCHEDULED_TASK_NAME).toBe('io.murge.desktop')
    expect(SCHEDULED_TASK_RUN_KEY).toContain('CurrentVersion\\Run')
  })
})
