import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiagnosticCollectionWarning, DiagnosticErrorCategory, DiagnosticPortLabel, DiagnosticReport } from '../../shared/diagnostics'
import type { KernelGateway, AppSettingsGateway, SystemProxyGateway } from '../../shared/gateways'
import type { TunGateway } from '../../shared/tun'
import type { TunConfigService } from '../tun/tun-config-service'
import type { CoreSettingsService } from '../kernel/core-settings-service'
import type { StartupTimeline } from '../startup/startup-timeline'

export interface DiagnosticHost {
  inspect(input: { device: string; ports: Array<{ label: DiagnosticPortLabel; port: number }>; kernelPid: number | null }): Promise<DiagnosticReport['host']>
}

export interface DiagnosticReportDeps {
  version: string
  platform: string
  arch: string
  timeline: StartupTimeline
  kernel: Pick<KernelGateway, 'getStatus'>
  systemProxy: Pick<SystemProxyGateway, 'getStatus'>
  tun: Pick<TunGateway, 'getStatus'>
  settings: Pick<AppSettingsGateway, 'get'>
  core: Pick<CoreSettingsService, 'getRaw'>
  tunConfig: Pick<TunConfigService, 'readConfig'>
  host: DiagnosticHost
  logDirectory: string
}

const PRIVACY = 'No raw logs, configuration, subscription URLs, controller secrets, domains or destinations are included.' as const

/** An explicit user action returns only fixed fields and aggregate error categories. */
export async function collectDiagnosticReport(deps: DiagnosticReportDeps): Promise<DiagnosticReport> {
  const [kernel, systemProxy, tun, settings, core, tunConfig] = await Promise.allSettled([
    Promise.resolve().then(() => deps.kernel.getStatus()),
    Promise.resolve().then(() => deps.systemProxy.getStatus()),
    Promise.resolve().then(() => deps.tun.getStatus()),
    Promise.resolve().then(() => deps.settings.get()),
    Promise.resolve().then(() => deps.core.getRaw()),
    Promise.resolve().then(() => deps.tunConfig.readConfig())
  ])
  const collectionWarnings: DiagnosticCollectionWarning[] = []
  if (kernel.status === 'rejected') collectionWarnings.push('kernel-status-unavailable')
  if (systemProxy.status === 'rejected') collectionWarnings.push('system-proxy-status-unavailable')
  if (tun.status === 'rejected') collectionWarnings.push('tun-status-unavailable')
  if (settings.status === 'rejected') collectionWarnings.push('settings-unavailable')
  if (core.status === 'rejected') collectionWarnings.push('core-settings-unavailable')
  if (tunConfig.status === 'rejected') collectionWarnings.push('tun-config-unavailable')
  const configuredPorts: Array<{ label: DiagnosticPortLabel; port: number }> = [
    { label: 'mixed', port: core.status === 'fulfilled' ? core.value.mixedPort : 0 },
    { label: 'http', port: core.status === 'fulfilled' ? core.value.httpPort : 0 },
    { label: 'socks', port: core.status === 'fulfilled' ? core.value.socksPort : 0 },
    { label: 'controller', port: core.status === 'fulfilled' ? core.value.controllerPort : 0 }
  ]
  const ports = configuredPorts.filter(({ port }) => Number.isInteger(port) && port > 0 && port <= 65535)
  const [host, recentErrors] = await Promise.allSettled([
    Promise.resolve().then(() => deps.host.inspect({ device: tunConfig.status === 'fulfilled' ? tunConfig.value.device : '', ports, kernelPid: kernel.status === 'fulfilled' ? kernel.value.pid : null })),
    Promise.resolve().then(() => summarizeRecentErrors(deps.logDirectory))
  ])
  if (host.status === 'rejected') collectionWarnings.push('host-inspection-unavailable')
  if (recentErrors.status === 'rejected') collectionWarnings.push('app-log-summary-unavailable')
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    app: { version: deps.version, platform: deps.platform, arch: deps.arch },
    startup: deps.timeline.snapshot(),
    runtime: {
      kernel: { phase: kernel.status === 'fulfilled' ? kernel.value.phase : 'unavailable', pid: kernel.status === 'fulfilled' ? kernel.value.pid : null },
      systemProxy: {
        desired: settings.status === 'fulfilled' ? settings.value.systemProxyDesired : null,
        phase: systemProxy.status === 'fulfilled' ? systemProxy.value.phase : 'unavailable',
        port: systemProxy.status === 'fulfilled' ? systemProxy.value.port : null
      },
      tun: { desired: settings.status === 'fulfilled' ? settings.value.tunDesired : null, phase: tun.status === 'fulfilled' ? tun.value.phase : 'unavailable' }
    },
    host: host.status === 'fulfilled' ? host.value : {
      startupTask: { state: 'unavailable', lastRunAt: null, lastResult: null },
      coreService: 'unavailable', tunAdapterPresent: null,
      systemProxyRegistry: { enabled: null, target: 'unavailable', port: null },
      ports: ports.map(({ label, port }) => ({ label, port, ownerPids: [], ownedByKernel: null }))
    },
    recentErrors: recentErrors.status === 'fulfilled' ? recentErrors.value : [],
    collectionWarnings,
    privacy: PRIVACY
  }
}

export function classifyDiagnosticError(line: string): DiagnosticErrorCategory {
  if (/controller secret mismatch|PROTOCOL_ERROR:UNAUTHORIZED/.test(line)) return 'controller-auth'
  if (/UPSTREAM_UNREACHABLE|controller unreachable/.test(line)) return 'controller-unreachable'
  if (/KERNEL_START|KERNEL_SPAWN|\[kernel\]|\[startup-restore\] kernel/.test(line)) return 'kernel-start'
  if (/\[tun\]|TUN_|TUN mode/i.test(line)) return 'tun'
  if (/\[system-proxy\]|SYSTEM_PROXY/.test(line)) return 'system-proxy'
  if (/\[profiles\]|subscription|provider/i.test(line)) return 'subscription'
  if (/\[updates\]|Cannot download|ERR_CONNECTION_ABORTED/i.test(line)) return 'update'
  return 'other'
}

/** Read only capped tails of app logs. Never return their text to the renderer. */
export async function summarizeRecentErrors(logDirectory: string): Promise<DiagnosticReport['recentErrors']> {
  const names = (await readdir(logDirectory).catch(() => []))
    .filter((name) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort().reverse().slice(0, 2)
  const categories = new Map<DiagnosticErrorCategory, { count: number; lastAt: string | null }>()
  for (const name of names) {
    const path = join(logDirectory, name)
    const size = await stat(path).then((item) => item.size).catch(() => 0)
    if (!size) continue
    const handle = await open(path, 'r').catch(() => null)
    if (!handle) continue
    try {
      const length = Math.min(size, 256 * 1024)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        if (!/\[(?:ERROR|WARN|WARNING)\]/.test(line)) continue
        const category = classifyDiagnosticError(line)
        const previous = categories.get(category) ?? { count: 0, lastAt: null }
        const match = /^\[([^\]]+)\]/.exec(line)
        const parsed = match && Number.isFinite(Date.parse(match[1])) ? new Date(match[1]).toISOString() : null
        categories.set(category, {
          count: previous.count + 1,
          lastAt: parsed && (!previous.lastAt || parsed > previous.lastAt) ? parsed : previous.lastAt
        })
      }
    } finally {
      await handle.close()
    }
  }
  return [...categories].map(([category, summary]) => ({ category, ...summary }))
}
