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
const onOff = (value: unknown, fallback: boolean): string => ((value === undefined ? fallback : value === true) ? '开启' : '关闭')

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
  const activity: InfoSection = { title: '活动', rows: rows([['活跃 TCP 连接', String(counts.tcp)], ['活跃 UDP 连接', String(counts.udp)]]) }

  if (kind === 'tailscale') {
    const exitNode = text(config['exit-node'])
    return [
      { title: '连接', rows: rows([['状态', runtime.status], ['控制服务器', text(config['control-url']) || 'controlplane.tailscale.com'], ['跳板策略', dialer]]) },
      { title: '设备', rows: rows([['设备名', text(config.hostname)], ['登录方式', text(config['auth-key']) ? 'Auth Key' : '登录链接（见“日志”页）'], ['临时设备', onOff(config.ephemeral, false)]]) },
      activity,
      { title: '路由', rows: rows([['Exit Node', exitNode || '未使用'], ['子网路由', onOff(config['accept-routes'], true)], ...(exitNode ? ([['局域网访问', onOff(config['exit-node-allow-lan-access'], true)]] as Array<[string, string]>) : [])]) }
    ]
  }

  if (kind === 'wireguard') {
    const peer = Array.isArray(config.peers) && config.peers.length === 1 && typeof config.peers[0] === 'object' ? (config.peers[0] as Record<string, unknown>) : config
    const server = text(peer.server)
    const port = text(peer.port)
    const peers = Array.isArray(config.peers) ? config.peers.length : 1
    return [
      { title: '连接', rows: rows([['状态', runtime.status], ['服务器', server ? (port ? `${server}:${port}` : server) : ''], ['Peer 数量', peers > 1 ? String(peers) : ''], ['跳板策略', dialer]]) },
      { title: '地址', rows: rows([['IPv4', text(config.ip)], ['IPv6', text(config.ipv6)], ['DNS', list(config.dns)], ['MTU', text(config.mtu)]]) },
      activity,
      { title: '路由', rows: rows([['Allowed IPs', list(peer['allowed-ips']) || '0.0.0.0/0, ::/0'], ['Keepalive', text(config['persistent-keepalive']) ? `${text(config['persistent-keepalive'])} 秒` : ''], ['远端 DNS 解析', onOff(config['remote-dns-resolve'], false)]]) }
    ]
  }

  return [activity]
}
