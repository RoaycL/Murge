import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DiagnosticReport } from '../../shared/diagnostics'
import { brand } from '../../shared/brand'
import { tunServiceIdentity } from '../tun/service-identity'
import { WindowsProxyPortProcessAdapter } from '../kernel/proxy-port-reclaimer'
import { WindowsSystemProxyAdapter } from '../system-proxy/adapters/windows-adapter'
import type { DiagnosticHost } from './report-service'

const execFileAsync = promisify(execFile)
type Host = DiagnosticReport['host']

const HOST_SCRIPT = `
$taskState = 'missing'; $lastRun = $null; $lastResult = $null
try {
  $task = Get-ScheduledTask -TaskName $env:MURGE_DIAG_TASK -ErrorAction Stop
  $taskState = if ($task.Settings.Enabled) { 'enabled' } else { 'disabled' }
  $info = Get-ScheduledTaskInfo -TaskName $env:MURGE_DIAG_TASK -ErrorAction Stop
  if ($info.LastRunTime.Year -gt 2000) { $lastRun = $info.LastRunTime.ToString('o') }
  $lastResult = [int]$info.LastTaskResult
} catch {
  $taskState = if ($_.FullyQualifiedErrorId -like '*NoMatching*') { 'missing' } else { 'unavailable' }
}
$serviceState = 'missing'
try {
  $service = Get-Service -Name $env:MURGE_DIAG_SERVICE -ErrorAction Stop
  $serviceState = $service.Status.ToString().ToLowerInvariant()
} catch {
  $serviceState = if ($_.FullyQualifiedErrorId -like '*NoServiceFoundForGivenName*') { 'missing' } else { 'unavailable' }
}
$adapterPresent = $null
try {
  if ($env:MURGE_DIAG_DEVICE) {
    $adapter = Get-NetAdapter -Name $env:MURGE_DIAG_DEVICE -ErrorAction Stop
    $adapterPresent = $true
  }
} catch {
  $adapterPresent = if ($_.FullyQualifiedErrorId -like '*NoMatching*' -or $_.FullyQualifiedErrorId -like '*NotFound*') { $false } else { $null }
}
[pscustomobject]@{taskState=$taskState;lastRun=$lastRun;lastResult=$lastResult;serviceState=$serviceState;adapterPresent=$adapterPresent} | ConvertTo-Json -Compress
`

export function parseWindowsHostOutput(stdout: string): Pick<Host, 'startupTask' | 'coreService' | 'tunAdapterPresent'> {
  const raw = JSON.parse(stdout) as Record<string, unknown>
  const state = raw.taskState
  const service = raw.serviceState
  const taskState: Host['startupTask']['state'] = state === 'enabled' || state === 'disabled' || state === 'missing' ? state : 'unavailable'
  const coreService: Host['coreService'] = service === 'running' || service === 'stopped' || service === 'starting' || service === 'missing' ? service : 'unavailable'
  return {
    startupTask: {
      state: taskState,
      lastRunAt: typeof raw.lastRun === 'string' && Number.isFinite(Date.parse(raw.lastRun)) ? new Date(raw.lastRun).toISOString() : null,
      lastResult: typeof raw.lastResult === 'number' && Number.isInteger(raw.lastResult) ? raw.lastResult : null
    },
    coreService,
    tunAdapterPresent: typeof raw.adapterPresent === 'boolean' ? raw.adapterPresent : null
  }
}

function readTaskAndService(device: string): Promise<Pick<Host, 'startupTask' | 'coreService' | 'tunAdapterPresent'>> {
  const unavailable = {
    startupTask: { state: 'unavailable' as const, lastRunAt: null, lastResult: null },
    coreService: 'unavailable' as const,
    tunAdapterPresent: null
  }
  if (process.platform !== 'win32') return Promise.resolve(unavailable)
  const env = {
    ...process.env,
    MURGE_DIAG_TASK: brand.appId,
    MURGE_DIAG_SERVICE: tunServiceIdentity(brand.appId).serviceName,
    MURGE_DIAG_DEVICE: device
  }
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HOST_SCRIPT], {
    env, windowsHide: true, timeout: 7_000, maxBuffer: 16 * 1024
  }).then(({ stdout }) => parseWindowsHostOutput(stdout)).catch(() => unavailable)
}

function readProxyRegistry(): Promise<Host['systemProxyRegistry']> {
  const unavailable = { enabled: null, target: 'unavailable' as const, port: null }
  if (process.platform !== 'win32') return Promise.resolve(unavailable)
  return new WindowsSystemProxyAdapter().read().then((snapshot) => {
    const enabled = snapshot.proxyEnable.value === 1
    if (!enabled) return { enabled: false, target: 'none' as const, port: null }
    const server = snapshot.proxyServer.value
    if (typeof server !== 'string') return { enabled: true, target: 'external' as const, port: null }
    const match = /^(?:http=|https=)?127\.0\.0\.1:(\d{1,5})$/i.exec(server.trim())
    const port = match ? Number(match[1]) : null
    return port && port <= 65535
      ? { enabled: true, target: 'loopback' as const, port }
      : { enabled: true, target: 'external' as const, port: null }
  }).catch(() => unavailable)
}

export class WindowsDiagnosticHost implements DiagnosticHost {
  async inspect(input: Parameters<DiagnosticHost['inspect']>[0]): Promise<Host> {
    const distinctPorts = [...new Set(input.ports.map(({ port }) => port))]
    const [host, registry, owners] = await Promise.all([
      readTaskAndService(input.device),
      readProxyRegistry(),
      new WindowsProxyPortProcessAdapter().inspect(distinctPorts).catch(() => null)
    ])
    return {
      ...host,
      systemProxyRegistry: registry,
      ports: input.ports.map(({ label, port }) => {
        const ownerPids = owners === null ? [] : owners.filter((owner) => owner.ports.includes(port)).map((owner) => owner.pid)
        return {
          label, port, ownerPids,
          ownedByKernel: owners === null || input.kernelPid === null ? null : ownerPids.includes(input.kernelPid)
        }
      })
    }
  }
}
