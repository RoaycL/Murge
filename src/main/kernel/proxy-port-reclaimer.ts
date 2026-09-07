import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

const execFileAsync = promisify(execFile)

export interface ProxyPortOwner {
  pid: number
  ports: number[]
}

export interface ProxyPortProcessAdapter {
  inspect(ports: readonly number[]): Promise<ProxyPortOwner[]>
  terminate(pid: number): Promise<void>
}

export interface ProxyPortReclaimOptions {
  maxAttempts?: number
  retryDelayMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 6
const DEFAULT_RETRY_DELAY_MS = 75

function normalizePorts(ports: readonly (number | undefined)[]): number[] {
  return Array.from(new Set(ports.filter((port): port is number =>
    Number.isInteger(port) && port !== undefined && port >= 1024 && port <= 65535
  )))
}

/**
 * Reclaim configured listener ports from whichever process currently owns them.
 * Only the listener process is terminated; its parent application is untouched.
 */
export async function reclaimProxyPorts(
  ports: readonly (number | undefined)[],
  adapter: ProxyPortProcessAdapter = new WindowsProxyPortProcessAdapter(),
  ownPid = process.pid,
  options: ProxyPortReclaimOptions = {}
): Promise<void> {
  const requested = normalizePorts(ports)
  if (requested.length === 0) return
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
  let lastTerminationError: unknown = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const owners = (await adapter.inspect(requested)).filter((owner) => owner.pid !== ownPid)
    if (owners.length === 0) return

    // A listener can disappear between inspection and termination. Treat that
    // race as provisional success and decide from the next port inspection;
    // genuine access-denied failures remain visible if the listener survives.
    const results = await Promise.allSettled(
      Array.from(new Set(owners.map((owner) => owner.pid)), (pid) => adapter.terminate(pid))
    )
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) lastTerminationError = rejected.reason
    if (attempt < maxAttempts - 1 && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }

  const remaining = (await adapter.inspect(requested)).filter((owner) => owner.pid !== ownPid)
  if (remaining.length > 0) {
    const detail = lastTerminationError instanceof Error ? `：${lastTerminationError.message}` : ''
    throw new ProtocolError(
      ProtocolErrorCode.KERNEL_RUNNING,
      `端口 ${Array.from(new Set(remaining.flatMap((owner) => owner.ports))).join('、')} ` +
      `仍被进程 ${Array.from(new Set(remaining.map((owner) => owner.pid))).join('、')} 占用，抢占失败${detail}`
    )
  }
}

interface PowerShellOwner {
  pid?: unknown
  port?: unknown
}

export const WINDOWS_PORT_INSPECT_SCRIPT = [
  "$ports = $args[0].Split(',') | ForEach-Object { [int]$_ }",
  "$tcp = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object { [PSCustomObject]@{ pid = $_.OwningProcess; port = $_.LocalPort } }",
  "$udp = Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object { [PSCustomObject]@{ pid = $_.OwningProcess; port = $_.LocalPort } }",
  '$rows = @($tcp) + @($udp)',
  '$rows | ConvertTo-Json -Compress'
].join('; ')

export class WindowsProxyPortProcessAdapter implements ProxyPortProcessAdapter {
  async inspect(ports: readonly number[]): Promise<ProxyPortOwner[]> {
    if (process.platform !== 'win32' || ports.length === 0) return []
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PORT_INSPECT_SCRIPT, ports.join(',')],
      { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 }
    )
    const text = stdout.trim()
    if (!text) return []
    const parsed = JSON.parse(text) as PowerShellOwner | PowerShellOwner[]
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const grouped = new Map<number, ProxyPortOwner>()
    for (const row of rows) {
      const pid = Number(row.pid)
      const port = Number(row.port)
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) continue
      const existing = grouped.get(pid)
      if (existing) {
        if (!existing.ports.includes(port)) existing.ports.push(port)
        continue
      }
      grouped.set(pid, {
        pid,
        ports: [port]
      })
    }
    return Array.from(grouped.values())
  }

  async terminate(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
    // Kill only the actual listener. In particular, do not walk upward to its
    // desktop parent or downward through an unrelated child process tree.
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/F'], {
      windowsHide: true,
      timeout: 5_000
    })
  }
}
