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

/** Proves that every configured TCP listener belongs to the expected core. */
export async function proxyPortsOwnedByPid(
  ports: readonly (number | undefined)[],
  pid: number,
  adapter: ProxyPortProcessAdapter = new WindowsProxyPortProcessAdapter()
): Promise<boolean> {
  const requested = normalizePorts(ports)
  if (requested.length === 0 || !Number.isInteger(pid) || pid <= 0) return false
  const owned = new Set(
    (await adapter.inspect(requested))
      .filter((owner) => owner.pid === pid)
      .flatMap((owner) => owner.ports)
  )
  return requested.every((port) => owned.has(port))
}

export function parseWindowsNetstat(text: string, ports: readonly number[]): ProxyPortOwner[] {
  const requested = new Set(ports)
  const grouped = new Map<number, ProxyPortOwner>()
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    const protocol = fields[0]?.toUpperCase()
    if (protocol !== 'TCP' && protocol !== 'UDP') continue
    if (protocol === 'TCP' && fields.at(-2)?.toUpperCase() !== 'LISTENING') continue
    const endpoint = fields[1] ?? ''
    const port = Number(endpoint.slice(endpoint.lastIndexOf(':') + 1))
    const pid = Number(fields.at(-1))
    if (!requested.has(port) || !Number.isInteger(pid) || pid <= 0) continue
    const existing = grouped.get(pid)
    if (existing) {
      if (!existing.ports.includes(port)) existing.ports.push(port)
    } else {
      grouped.set(pid, { pid, ports: [port] })
    }
  }
  return Array.from(grouped.values())
}

export class WindowsProxyPortProcessAdapter implements ProxyPortProcessAdapter {
  async inspect(ports: readonly number[]): Promise<ProxyPortOwner[]> {
    if (process.platform !== 'win32' || ports.length === 0) return []
    const { stdout } = await execFileAsync('netstat.exe', ['-ano'], {
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024
    })
    return parseWindowsNetstat(stdout, ports)
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
