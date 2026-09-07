import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

const execFileAsync = promisify(execFile)

export interface ProxyPortOwner {
  pid: number
  ports: number[]
  name: string
  executablePath: string
  commandLine: string
}

export interface ProxyPortProcessAdapter {
  inspect(ports: readonly number[]): Promise<ProxyPortOwner[]>
  terminate(pid: number): Promise<void>
}

const KNOWN_CORE_NAMES = new Set([
  'clash.exe',
  'clash-meta.exe',
  'clash-win64.exe',
  'clash-windows-amd64.exe',
  'mihomo.exe',
  'verge-mihomo.exe'
])
const PROXY_IDENTITY_MARKER = /(?:^|[\\/\s._-])(clash|mihomo|clash-verge|clash-party|nyanpasu|flclash)(?:[\\/\s._-]|$)/i

export function isRecognizedClashProcess(owner: ProxyPortOwner): boolean {
  const name = owner.name.trim().toLowerCase()
  if (KNOWN_CORE_NAMES.has(name)) return true
  // `core.exe` is intentionally not trusted by name: many unrelated programs
  // use it. Accept generic names only when their installed path or command line
  // also carries an unmistakable Clash-family marker.
  return PROXY_IDENTITY_MARKER.test(`${owner.name} ${owner.executablePath} ${owner.commandLine}`)
}

function normalizePorts(ports: readonly (number | undefined)[]): number[] {
  return Array.from(new Set(ports.filter((port): port is number =>
    Number.isInteger(port) && port !== undefined && port >= 1024 && port <= 65535
  )))
}

/**
 * Reclaim configured listener ports from another Clash-family core.
 * Unknown processes are never terminated: a clear conflict is returned so the
 * user can resolve it without the application guessing about process ownership.
 */
export async function reclaimProxyPorts(
  ports: readonly (number | undefined)[],
  adapter: ProxyPortProcessAdapter = new WindowsProxyPortProcessAdapter(),
  ownPid = process.pid
): Promise<void> {
  const requested = normalizePorts(ports)
  if (requested.length === 0) return

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owners = (await adapter.inspect(requested)).filter((owner) => owner.pid !== ownPid)
    if (owners.length === 0) return

    const unknown = owners.find((owner) => !isRecognizedClashProcess(owner))
    if (unknown) {
      throw new ProtocolError(
        ProtocolErrorCode.KERNEL_RUNNING,
        `端口 ${unknown.ports.join('、')} 已被 ${unknown.name || `PID ${unknown.pid}`} 占用。为避免误关普通程序，本应用未执行抢占。`
      )
    }

    for (const owner of owners) await adapter.terminate(owner.pid)
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const remaining = (await adapter.inspect(requested)).filter((owner) => owner.pid !== ownPid)
  if (remaining.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.KERNEL_RUNNING,
      `其他 Clash 正在反复占用端口 ${remaining.flatMap((owner) => owner.ports).join('、')}，请先退出该 Clash 客户端。`
    )
  }
}

interface PowerShellOwner {
  pid?: unknown
  port?: unknown
  name?: unknown
  executablePath?: unknown
  commandLine?: unknown
}

const INSPECT_SCRIPT = [
  "$ports = $args[0].Split(',') | ForEach-Object { [int]$_ }",
  '$rows = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object {',
  '  $process = Get-CimInstance Win32_Process -Filter (\'ProcessId = {0}\' -f $_.OwningProcess) -ErrorAction SilentlyContinue',
  '  [PSCustomObject]@{ pid = $_.OwningProcess; port = $_.LocalPort; name = $process.Name; executablePath = $process.ExecutablePath; commandLine = $process.CommandLine }',
  '}',
  '$rows | ConvertTo-Json -Compress'
].join('; ')

export class WindowsProxyPortProcessAdapter implements ProxyPortProcessAdapter {
  async inspect(ports: readonly number[]): Promise<ProxyPortOwner[]> {
    if (process.platform !== 'win32' || ports.length === 0) return []
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', INSPECT_SCRIPT, ports.join(',')],
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
        ports: [port],
        name: typeof row.name === 'string' ? row.name : '',
        executablePath: typeof row.executablePath === 'string' ? row.executablePath : '',
        commandLine: typeof row.commandLine === 'string' ? row.commandLine : ''
      })
    }
    return Array.from(grouped.values())
  }

  async terminate(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5_000
    })
  }
}
