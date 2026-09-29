import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installConsoleFileLogging } from '../src/main/logging/console-bridge'
import { StartupTimeline } from '../src/main/startup/startup-timeline'
import { collectDiagnosticReport, summarizeRecentErrors } from '../src/main/diagnostics/report-service'
import { parseWindowsHostOutput } from '../src/main/diagnostics/windows-host'
import { EMPTY_CORE_SETTINGS } from '../src/shared/core-settings'
import { DEFAULT_APP_SETTINGS } from '../src/shared/app-settings'
import { EMPTY_TUN_CONFIG } from '../src/shared/tun-config'
import type { DiagnosticHost } from '../src/main/diagnostics/report-service'
import type { FileLogService } from '../src/main/logging/file-log-service'

const tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('startup diagnostics', () => {
  it('persists console.info at info level and restores the original console method', () => {
    const writes: unknown[][] = []
    const restore = installConsoleFileLogging({
      writeApp: (...args: unknown[]) => { writes.push(args); return Promise.resolve() }
    } as unknown as FileLogService)
    try {
      console.info('[startup-timing] controller-ready in 123ms')
      expect(writes).toContainEqual(['info', ['[startup-timing] controller-ready in 123ms']])
    } finally {
      restore()
    }
    const count = writes.length
    console.info('console bridge restored')
    expect(writes).toHaveLength(count)
  })

  it('records monotonic milestones once without exposing mutable references', () => {
    let now = 100
    const log = vi.fn()
    const timeline = new StartupTimeline(() => now, () => new Date('2026-09-29T00:00:00Z'), log)
    now = 145
    timeline.mark('electron-ready')
    timeline.mark('electron-ready')
    now = 191
    timeline.mark('kernel-ready')
    const snapshot = timeline.snapshot()
    expect(snapshot).toEqual({
      processStartedAt: '2026-09-29T00:00:00.000Z',
      marks: [{ stage: 'electron-ready', elapsedMs: 45 }, { stage: 'kernel-ready', elapsedMs: 91 }]
    })
    snapshot.marks[0].elapsedMs = 0
    expect(timeline.snapshot().marks[0].elapsedMs).toBe(45)
    expect(log).toHaveBeenCalledTimes(2)
    timeline.seal()
    timeline.mark('tun-active')
    expect(timeline.snapshot().marks).toHaveLength(2)
  })

  it('exports fixed status fields and aggregate errors, never raw secrets or log lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'murge-diagnostic-test-'))
    tempRoots.push(root)
    await writeFile(join(root, 'app-2026-09-29.log'), [
      '[2026-09-29T01:00:00.000Z] [ERROR] controller secret mismatch https://secret.example/?token=private',
      '[2026-09-29T01:01:00.000Z] [WARN] [tun] private.example 192.168.1.10'
    ].join('\n'))
    const host: DiagnosticHost = {
      inspect: vi.fn(async () => ({
        startupTask: { state: 'enabled', lastRunAt: '2026-09-29T00:59:00Z', lastResult: 267009 },
        coreService: 'running', tunAdapterPresent: true,
        systemProxyRegistry: { enabled: true, target: 'loopback', port: 7890 },
        ports: [{ label: 'mixed', port: 7890, ownerPids: [42], ownedByKernel: true }]
      }))
    }
    const report = await collectDiagnosticReport({
      version: '0.9.20', platform: 'win32', arch: 'x64',
      timeline: new StartupTimeline(() => 0, () => new Date('2026-09-29T00:00:00Z')),
      kernel: { getStatus: () => ({ phase: 'running', pid: 42, version: null, controllerUrl: 'https://private.example/', startedAt: null, lastError: 'secret=private' }) },
      systemProxy: { getStatus: () => ({ supported: true, phase: 'enabled', address: null, port: 7890, proxyOverride: 'private.example', errorMessage: 'password=private', conflictDetail: null, updatedAt: null }) },
      tun: { getStatus: () => ({ supported: true, phase: 'active', errorMessage: 'token=private', conflictDetail: null, updatedAt: null }) },
      settings: { get: async () => ({ ...DEFAULT_APP_SETTINGS, tunDesired: true, systemProxyDesired: true }) },
      core: { getRaw: async () => ({ ...EMPTY_CORE_SETTINGS, controllerSecret: 'private' }) },
      tunConfig: { readConfig: async () => ({ ...EMPTY_TUN_CONFIG, device: 'private-device' }) },
      host, logDirectory: root
    })
    const text = JSON.stringify(report)
    expect(report.recentErrors).toEqual([
      { category: 'controller-auth', count: 1, lastAt: '2026-09-29T01:00:00.000Z' },
      { category: 'tun', count: 1, lastAt: '2026-09-29T01:01:00.000Z' }
    ])
    expect(text).not.toMatch(/private|secret\.example|192\.168|password=|token=/)
    expect(host.inspect).toHaveBeenCalledWith(expect.objectContaining({ device: 'private-device', kernelPid: 42 }))
  })

  it('does not return raw log text when a category is unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'murge-diagnostic-test-'))
    tempRoots.push(root)
    await writeFile(join(root, 'app-2026-09-29.log'), '[2026-09-29T00:00:00.000Z] [ERROR] arbitrary secret here')
    expect(await summarizeRecentErrors(root)).toEqual([{ category: 'other', count: 1, lastAt: '2026-09-29T00:00:00.000Z' }])
  })

  it('still exports a report when runtime and host inspection fail', async () => {
    const failure = () => { throw new Error('secret=private') }
    const report = await collectDiagnosticReport({
      version: '0.9.20', platform: 'win32', arch: 'x64',
      timeline: new StartupTimeline(() => 0, () => new Date('2026-09-29T00:00:00Z')),
      kernel: { getStatus: failure }, systemProxy: { getStatus: failure }, tun: { getStatus: failure },
      settings: { get: failure }, core: { getRaw: failure }, tunConfig: { readConfig: failure },
      host: { inspect: failure }, logDirectory: 'nonexistent-diagnostic-log-directory'
    })
    expect(report.runtime).toEqual({
      kernel: { phase: 'unavailable', pid: null },
      systemProxy: { desired: null, phase: 'unavailable', port: null },
      tun: { desired: null, phase: 'unavailable' }
    })
    expect(report.host.startupTask.state).toBe('unavailable')
    expect(report.collectionWarnings).toContain('host-inspection-unavailable')
    expect(JSON.stringify(report)).not.toContain('secret=private')
  })

  it('whitelists native task/service output before including it in a report', () => {
    const native = JSON.stringify({
      taskState: 'enabled', lastRun: '2026-09-29T08:00:00+08:00', lastResult: 267009,
      serviceState: 'running', adapterPresent: true, secret: 'private.example'
    })
    const output = parseWindowsHostOutput(native)
    expect(output.startupTask.lastRunAt).toBe('2026-09-29T00:00:00.000Z')
    expect(JSON.stringify(output)).not.toContain('private.example')
    expect(parseWindowsHostOutput('{"taskState":"arbitrary","serviceState":"bad"}')).toMatchObject({
      startupTask: { state: 'unavailable' }, coreService: 'unavailable', tunAdapterPresent: null
    })
  })
})
