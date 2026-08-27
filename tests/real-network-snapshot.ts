import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Host-level network integrity evidence for the real-kernel integration test.
 *
 * A mihomo run must never mutate the host's proxy settings, default routes, DNS
 * or firewall. Before and after the real test we capture a structured snapshot
 * of these safety-relevant fields and refuse to let the test pass if any of them
 * changed. Volatile fields (packet counters, dynamic sockets, uptime) are never
 * captured, so the comparison is deterministic.
 *
 * See the Phase 7 security review — P1 #9 "missing network before/after diff".
 */

export interface NetworkSnapshot {
  [key: string]: string
}

async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args)
    return stdout.trim()
  } catch (error) {
    // A missing probe must not crash the snapshot, but its 'unavailable' marker
    // is part of the comparison so a probe that disappears between captures is
    // still detected as a change.
    return `UNAVAILABLE:${(error as Error).message}`
  }
}

/** Capture the safety-relevant network state into a stable, comparable record. */
export async function captureNetworkSnapshot(): Promise<NetworkSnapshot> {
  if (process.platform === 'win32') {
    const ps = (script: string) =>
      run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    const winhttp = await run('netsh', ['winhttp', 'show', 'proxy'])
    const ieProxy = await ps(
      `Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride | ConvertTo-Json -Compress`
    )
    const ipv4Route = await ps(
      `Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object NextHop,InterfaceAlias | ConvertTo-Json -Compress`
    )
    const ipv6Route = await ps(
      `Get-NetRoute -DestinationPrefix '::/0' | Select-Object NextHop,InterfaceAlias | ConvertTo-Json -Compress`
    )
    const dns = await ps(
      `Get-DnsClientServerAddress | Where-Object { $_.ServerAddresses } | Select-Object InterfaceAlias,ServerAddresses | ConvertTo-Json -Compress`
    )
    const adapters = await ps(
      `Get-NetAdapter | Select-Object Name,Status | ConvertTo-Json -Compress`
    )
    const firewall = await ps(
      `Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Compress`
    )
    return {
      winhttpProxy: winhttp,
      internetSettingsProxy: ieProxy,
      ipv4DefaultRoute: ipv4Route,
      ipv6DefaultRoute: ipv6Route,
      dnsServers: dns,
      activeAdapters: adapters,
      firewallProfiles: firewall
    }
  }

  // Non-Windows (the dev host): capture the same safety-relevant fields.
  const ipv4Route = await run('ip', ['route', 'show', 'default'])
  const ipv6Route = await run('ip', ['-6', 'route', 'show', 'default'])
  let dns = await run('cat', ['/etc/resolv.conf'])
  dns = dns
    .split('\n')
    .filter((l) => l.includes('nameserver'))
    .join('\n')
  const adapters = await run('ip', ['-o', 'link', 'show'])
  const firewallIp = await run('iptables', ['-S'])
  const firewallNft = await run('nft', ['list', 'ruleset'])
  return {
    winhttpProxy: 'N/A (non-Windows)',
    internetSettingsProxy: 'N/A (non-Windows)',
    ipv4DefaultRoute: ipv4Route,
    ipv6DefaultRoute: ipv6Route,
    dnsServers: dns,
    activeAdapters: adapters,
    firewallProfiles: `${firewallIp}\n${firewallNft}`
  }
}

/**
 * Assert the before/after snapshots are identical on every safety-relevant field.
 * Throws a Protocolless `Error` (so the gated test fails hard) listing each
 * changed field and a sanitized before/after diff. Never prints secrets.
 */
export function assertNetworkUnchanged(
  before: NetworkSnapshot,
  after: NetworkSnapshot
): void {
  const diffs: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const a = before[key] ?? 'MISSING'
    const b = after[key] ?? 'MISSING'
    if (a !== b) {
      diffs.push(`- ${key}\n  before: ${sanitize(a.slice(0, 400))}\n  after:  ${sanitize(b.slice(0, 400))}`)
    }
  }
  if (diffs.length) {
    throw new Error(
      `mihomo mutated the host network (${diffs.length} field(s) changed):\n${diffs.join('\n')}`
    )
  }
}

function sanitize(text: string): string {
  return text.replace(/(token|secret|password)=[^\s,;]+/gi, '$1=<redacted>')
}
