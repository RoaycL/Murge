import { describe, expect, it, vi } from 'vitest'
import {
  ScheduledTaskStartupAdapter,
  scheduledTaskExitCode,
  taskSettingsEnabled,
  SCHEDULED_TASK_NAME,
  SCHEDULED_TASK_RUN_KEY
} from '../src/main/startup/scheduled-task-adapter'
import { StartupService } from '../src/main/startup/service'
import type { StartupAdapter } from '../src/main/startup/service'

vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => undefined
  }
}))

function taskXml(enabled: boolean): string {
  return `<?xml version="1.0"?><Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`
}

function makeAdapter(options: {
  task?: boolean | null
  denyChange?: boolean
  runEntry?: boolean
  legacyEntry?: boolean
} = {}) {
  const state = {
    task: options.task ?? null,
    runEntry: options.runEntry ?? false,
    legacyEntry: options.legacyEntry ?? false
  }
  const calls: string[][] = []
  const legacyWrites: boolean[] = []
  const legacy: StartupAdapter = {
    supported: true,
    read: async () => state.legacyEntry,
    readRegistered: async () => state.legacyEntry,
    write: async (enabled) => {
      state.legacyEntry = enabled
      legacyWrites.push(enabled)
    }
  }
  const adapter = new ScheduledTaskStartupAdapter(
    () => false,
    async (command, args) => {
      calls.push([command, ...args])
      if (command.includes('schtasks')) {
        if (args[0] === '/query') {
          return state.task === null
            ? { code: 1, stdout: '', stderr: 'not found' }
            : { code: 0, stdout: taskXml(state.task), stderr: '' }
        }
        if (args[0] === '/change') {
          if (options.denyChange) return { code: 1, stdout: '', stderr: 'Access is denied' }
          state.task = args.includes('/enable')
          return { code: 0, stdout: 'SUCCESS', stderr: '' }
        }
        throw new Error(`Unexpected task command: ${args.join(' ')}`)
      }
      if (args[0] === 'query') {
        const legacyName = args[args.length - 1]!.startsWith('electron.app.')
        const present = legacyName ? state.legacyEntry : state.runEntry
        const name = args[args.length - 1]!
        return present
          ? { code: 0, stdout: `${name} REG_SZ "${process.execPath}" --hidden`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'not found' }
      }
      if (args[0] === 'add') {
        state.runEntry = true
        return { code: 0, stdout: 'SUCCESS', stderr: '' }
      }
      if (args[0] === 'delete') {
        if (args[args.length - 1]!.startsWith('electron.app.')) state.legacyEntry = false
        else state.runEntry = false
        return { code: 0, stdout: 'SUCCESS', stderr: '' }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
    },
    { supported: true, legacy }
  )
  return { adapter, state, calls, legacyWrites }
}

describe('installer-managed startup task', () => {
  it('reads the task-level enabled state', () => {
    expect(taskSettingsEnabled(taskXml(true))).toBe(true)
    expect(taskSettingsEnabled(taskXml(false))).toBe(false)
  })

  it('enables an installer-created disabled task without creating a new one', async () => {
    const { adapter, state, calls } = makeAdapter({ task: false, runEntry: true })
    await adapter.write(true)
    expect(state.task).toBe(true)
    expect(state.runEntry).toBe(false)
    expect(calls.some((call) => call.includes('/enable'))).toBe(true)
    expect(calls.some((call) => call.includes('/create'))).toBe(false)
    expect(await adapter.read()).toBe(true)
  })

  it('uses the Run-key fallback if a task is missing', async () => {
    const { adapter, state, calls } = makeAdapter()
    await adapter.write(true)
    expect(state.runEntry).toBe(true)
    expect(calls.some((call) => call.includes('/create'))).toBe(false)
    expect(await adapter.read()).toBe(true)
  })

  it('uses the Run-key fallback if changing a disabled task is denied', async () => {
    const { adapter, state } = makeAdapter({ task: false, denyChange: true })
    await adapter.write(true)
    expect(state.task).toBe(false)
    expect(state.runEntry).toBe(true)
    expect(await adapter.read()).toBe(true)
  })

  it('disables a running task but leaves its definition for future toggles', async () => {
    const { adapter, state, calls } = makeAdapter({ task: true })
    await adapter.write(false)
    expect(state.task).toBe(false)
    expect(calls.some((call) => call.includes('/disable'))).toBe(true)
    expect(calls.some((call) => call.includes('/delete'))).toBe(false)
    expect(await adapter.read()).toBe(false)
  })

  it('reports denied task disable instead of falsely claiming auto-start is off', async () => {
    const { adapter, state } = makeAdapter({ task: true, denyChange: true })
    const status = await new StartupService(adapter).setEnabled(false)
    expect(status).toMatchObject({ enabled: true, phase: 'error' })
    expect(state.task).toBe(true)
  })

  it('keeps an enabled task and removes duplicate Run entries on refresh', async () => {
    const { adapter, state, calls } = makeAdapter({ task: true, runEntry: true, legacyEntry: true })
    await adapter.rewriteIfEnabled()
    expect(state.runEntry).toBe(false)
    expect(state.legacyEntry).toBe(false)
    expect(calls.some((call) => call.includes('/create'))).toBe(false)
  })

  it('keeps a legacy-only startup entry without trying to create a task', async () => {
    const { adapter, state, calls } = makeAdapter({ legacyEntry: true })
    await adapter.rewriteIfEnabled()
    expect(state.runEntry).toBe(true)
    expect(state.legacyEntry).toBe(false)
    expect(calls.some((call) => call.includes('/create'))).toBe(false)
  })

  it('disables both task and Run-key fallback after a denied enable', async () => {
    const { adapter, state } = makeAdapter({ task: false, denyChange: true, runEntry: true })
    await adapter.write(false)
    expect(state.runEntry).toBe(false)
    expect(await adapter.read()).toBe(false)
  })
})

describe('startup task constants and command errors', () => {
  it('preserves child exit codes and rejects timeouts', () => {
    expect(scheduledTaskExitCode(null)).toBe(0)
    expect(scheduledTaskExitCode(Object.assign(new Error('denied'), { code: 5 }))).toBe(5)
    expect(() => scheduledTaskExitCode(Object.assign(new Error('timeout'), {
      code: null,
      killed: true
    }))).toThrow('ETIMEDOUT')
  })

  it('uses the stable brand task and Run-key names', () => {
    expect(SCHEDULED_TASK_NAME).toBe('io.murge.desktop')
    expect(SCHEDULED_TASK_RUN_KEY).toContain('CurrentVersion\\Run')
  })
})
