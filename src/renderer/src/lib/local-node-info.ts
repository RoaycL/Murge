import { t } from '@shared/i18n'
import type { MihomoConnection } from '@shared/mihomo-api'

export interface InfoRow {
  label: string
  value: string
}

export interface InfoSection {
  title: string
  rows: InfoRow[]
}

export interface NodeRuntime {
  /** 运行中 / 未生效 / 已停用 / 内核未运行. */
  status: string
  /** Active connections whose exit is this node. */
  connections: readonly MihomoConnection[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')
const list = (value: unknown): string => (Array.isArray(value) ? value.map(text).filter(Boolean).join(', ') : text(value))
const onOff = (value: unknown, fallback: boolean): string => ((value === undefined ? fallback : value === true) ? t('common.on') : t('common.off'))

/** Active TCP and UDP connections whose chain ends at `name`. */
export function activeCounts(name: string, connections: readonly MihomoConnection[]): { tcp: number; udp: number } {
  let tcp = 0
  let udp = 0
  for (const connection of connections) {
    if (connection.chains[0] !== name) continue
    if (String(connection.metadata.network ?? '').toLowerCase() === 'udp') udp++
    else tcp++
  }
  return { tcp, udp }
}

function rows(entries: Array<[string, string]>): InfoRow[] {
  return entries.filter(([, value]) => value !== '').map(([label, value]) => ({ label, value }))
}

/**
 * The Surge-style detail list shown when right-clicking a Tailscale or
 * WireGuard node. Only what the kernel exposes is shown: mihomo has no
 * status API for its embedded Tailscale, so tailnet addresses, DERP and
 * peers are not available.
 */
export function nodeInfoSections(config: Record<string, unknown>, runtime: NodeRuntime): InfoSection[] {
  const kind = String(config.type ?? '').toLowerCase()
  const name = text(config.name)
  const counts = activeCounts(name, runtime.connections)
  const dialer = text(config['dialer-proxy']) || 'DIRECT'
  const activity: InfoSection = { title: t('nav.activity'), rows: rows([[t('nodeInfo.activeTcp'), String(counts.tcp)], [t('nodeInfo.activeUdp'), String(counts.udp)]]) }

  if (kind === 'tailscale') {
    const exitNode = text(config['exit-node'])
    return [
      { title: t('common.connection'), rows: rows([[t('common.status'), runtime.status], [t('nodeInfo.controlServer'), text(config['control-url']) || 'controlplane.tailscale.com'], [t('nodeInfo.dialerProxy'), dialer]]) },
      { title: t('nodeInfo.device'), rows: rows([[t('nodeInfo.deviceName'), text(config.hostname)], [t('nodeInfo.loginMethod'), text(config['auth-key']) ? 'Auth Key' : t('nodeInfo.loginLink')], [t('nodeInfo.ephemeral'), onOff(config.ephemeral, false)]]) },
      activity,
      { title: t('nodeInfo.routes'), rows: rows([['Exit Node', exitNode || t('nodeInfo.unused')], [t('nodeInfo.subnetRoutes'), onOff(config['accept-routes'], true)], ...(exitNode ? ([[t('nodeInfo.lanAccess'), onOff(config['exit-node-allow-lan-access'], true)]] as Array<[string, string]>) : [])]) }
    ]
  }

  if (kind === 'wireguard') {
    const peer = Array.isArray(config.peers) && config.peers.length === 1 && typeof config.peers[0] === 'object' ? (config.peers[0] as Record<string, unknown>) : config
    const server = text(peer.server)
    const port = text(peer.port)
    const peers = Array.isArray(config.peers) ? config.peers.length : 1
    return [
      { title: t('common.connection'), rows: rows([[t('common.status'), runtime.status], [t('nodeInfo.server'), server ? (port ? `${server}:${port}` : server) : ''], [t('nodeInfo.peerCount'), peers > 1 ? String(peers) : ''], [t('nodeInfo.dialerProxy'), dialer]]) },
      { title: t('common.address'), rows: rows([['IPv4', text(config.ip)], ['IPv6', text(config.ipv6)], ['DNS', list(config.dns)], ['MTU', text(config.mtu)]]) },
      activity,
      { title: t('nodeInfo.routes'), rows: rows([['Allowed IPs', list(peer['allowed-ips']) || '0.0.0.0/0, ::/0'], ['Keepalive', text(config['persistent-keepalive']) ? t('nodeInfo.seconds', [text(config['persistent-keepalive'])]) : ''], [t('nodeInfo.remoteDns'), onOff(config['remote-dns-resolve'], false)]]) }
    ]
  }

  return [activity]
}
