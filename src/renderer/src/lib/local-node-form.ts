/**
 * Form models for the 本地节点 editor: WireGuard and Tailscale fields <->
 * mihomo proxy maps. Keys the form does not manage are preserved on save.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ProxyConfig } from '@shared/local'

export type NodeEditorKind = 'wireguard' | 'tailscale' | 'yaml'

export interface WireGuardForm {
  name: string
  server: string
  port: string
  privateKey: string
  publicKey: string
  preSharedKey: string
  ip: string
  ipv6: string
  allowedIps: string
  dns: string
  mtu: string
  keepalive: string
  reserved: string
  dialerProxy: string
}

export interface TailscaleForm {
  name: string
  authKey: string
  hostname: string
  controlUrl: string
  exitNode: string
  acceptRoutes: boolean
  exitNodeAllowLanAccess: boolean
  ephemeral: boolean
  dialerProxy: string
}

const str = (value: unknown): string => (value === undefined || value === null ? '' : Array.isArray(value) ? value.join(', ') : String(value))
const list = (value: string): string[] => value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)

/** Fields the WireGuard form cannot show: edit those nodes as YAML. */
export function wireGuardNeedsYaml(config: Record<string, unknown>): boolean {
  return Array.isArray(config.peers) || config['amnezia-wg-option'] !== undefined || (config['ip-stack'] !== undefined)
}

export function emptyWireGuardForm(): WireGuardForm {
  return { name: '', server: '', port: '51820', privateKey: '', publicKey: '', preSharedKey: '', ip: '', ipv6: '', allowedIps: '0.0.0.0/0, ::/0', dns: '', mtu: '', keepalive: '', reserved: '', dialerProxy: '' }
}

export function wireGuardFormFrom(config: Record<string, unknown>): WireGuardForm {
  return {
    name: str(config.name),
    server: str(config.server),
    port: str(config.port),
    privateKey: str(config['private-key']),
    publicKey: str(config['public-key']),
    preSharedKey: str(config['pre-shared-key']),
    ip: str(config.ip),
    ipv6: str(config.ipv6),
    allowedIps: str(config['allowed-ips']),
    dns: config['remote-dns-resolve'] === true ? str(config.dns) : '',
    mtu: str(config.mtu),
    keepalive: str(config['persistent-keepalive']),
    reserved: Array.isArray(config.reserved) ? config.reserved.join('/') : str(config.reserved),
    dialerProxy: str(config['dialer-proxy'])
  }
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete target[key]
  else target[key] = value
}

function intField(label: string, value: string, min: number, max: number): number | undefined {
  if (!value.trim()) return undefined
  const number = Number(value.trim())
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}应为 ${min}-${max} 的整数`)
  return number
}

function parseReserved(value: string): number[] | string | undefined {
  const text = value.trim()
  if (!text) return undefined
  const numbers = text.split(/[/,\s]+/).filter(Boolean).map(Number)
  if (numbers.length === 3 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return numbers
  if (/^[A-Za-z0-9+/]{4}$/.test(text)) return text
  throw new Error('Reserved 应为 1/2/3 形式的三个字节，或 4 位 base64')
}

export function wireGuardConfigFrom(form: WireGuardForm, base: Record<string, unknown> = {}): ProxyConfig {
  const name = form.name.trim()
  if (!name) throw new Error('请填写名称')
  if (!form.server.trim()) throw new Error('请填写服务器地址')
  if (!form.privateKey.trim()) throw new Error('请填写本机私钥')
  if (!form.publicKey.trim()) throw new Error('请填写对端公钥')
  if (!form.ip.trim() && !form.ipv6.trim()) throw new Error('请至少填写一个隧道地址')
  const config: Record<string, unknown> = { ...base, name, type: 'wireguard' }
  config.server = form.server.trim()
  config.port = intField('端口', form.port || '51820', 1, 65535)
  config['private-key'] = form.privateKey.trim()
  config['public-key'] = form.publicKey.trim()
  setOrDelete(config, 'pre-shared-key', form.preSharedKey.trim())
  setOrDelete(config, 'ip', form.ip.trim())
  setOrDelete(config, 'ipv6', form.ipv6.trim())
  setOrDelete(config, 'allowed-ips', list(form.allowedIps).length ? list(form.allowedIps) : ['0.0.0.0/0', '::/0'])
  const dns = list(form.dns)
  setOrDelete(config, 'dns', dns)
  setOrDelete(config, 'remote-dns-resolve', dns.length ? true : undefined)
  setOrDelete(config, 'mtu', intField('MTU ', form.mtu, 576, 9000))
  setOrDelete(config, 'persistent-keepalive', intField('Keepalive ', form.keepalive, 1, 3600))
  setOrDelete(config, 'reserved', parseReserved(form.reserved))
  setOrDelete(config, 'dialer-proxy', form.dialerProxy.trim())
  if (config.udp === undefined) config.udp = true
  return config as ProxyConfig
}

export function emptyTailscaleForm(): TailscaleForm {
  return { name: 'Tailscale', authKey: '', hostname: 'murge', controlUrl: '', exitNode: '', acceptRoutes: true, exitNodeAllowLanAccess: true, ephemeral: false, dialerProxy: '' }
}

export function tailscaleFormFrom(config: Record<string, unknown>): TailscaleForm {
  return {
    name: str(config.name),
    authKey: str(config['auth-key']),
    hostname: str(config.hostname),
    controlUrl: str(config['control-url']),
    exitNode: str(config['exit-node']),
    acceptRoutes: config['accept-routes'] !== false,
    exitNodeAllowLanAccess: config['exit-node-allow-lan-access'] !== false,
    ephemeral: config.ephemeral === true,
    dialerProxy: str(config['dialer-proxy'])
  }
}

export function tailscaleConfigFrom(form: TailscaleForm, base: Record<string, unknown> = {}): ProxyConfig {
  const name = form.name.trim()
  if (!name) throw new Error('请填写名称')
  const controlUrl = form.controlUrl.trim()
  if (controlUrl && !/^https?:\/\/[^\s]+$/i.test(controlUrl)) throw new Error('控制服务器应为 http(s):// 地址')
  const hostname = form.hostname.trim()
  if (hostname && !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(hostname)) throw new Error('设备名只能包含字母、数字和连字符')
  const config: Record<string, unknown> = { ...base, name, type: 'tailscale' }
  setOrDelete(config, 'auth-key', form.authKey.trim())
  setOrDelete(config, 'hostname', hostname)
  setOrDelete(config, 'control-url', controlUrl)
  setOrDelete(config, 'exit-node', form.exitNode.trim())
  config['accept-routes'] = form.acceptRoutes
  setOrDelete(config, 'exit-node-allow-lan-access', form.exitNode.trim() ? form.exitNodeAllowLanAccess : undefined)
  setOrDelete(config, 'ephemeral', form.ephemeral ? true : undefined)
  setOrDelete(config, 'dialer-proxy', form.dialerProxy.trim())
  config.udp = true
  return config as ProxyConfig
}

export function configToYaml(config: Record<string, unknown>): string {
  return stringifyYaml(config, { lineWidth: 0 }).trimEnd() + '\n'
}

function asProxy(value: unknown, index: number): ProxyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`第 ${index + 1} 个节点不是键值对象`)
  const config = value as Record<string, unknown>
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error(`第 ${index + 1} 个节点缺少 name`)
  if (typeof config.type !== 'string' || !config.type.trim()) throw new Error(`节点「${config.name}」缺少 type`)
  return { ...config, name: config.name.trim(), type: config.type.trim() } as ProxyConfig
}

/**
 * Parse pasted mihomo YAML: one proxy map, a list of them, or a document
 * with a `proxies:` list.
 */
export function parseProxiesYaml(text: string): ProxyConfig[] {
  let value: unknown
  try {
    value = parseYaml(text)
  } catch (error) {
    throw new Error(`YAML 格式错误：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { proxies?: unknown }).proxies)) {
    value = (value as { proxies: unknown[] }).proxies
  }
  const items = Array.isArray(value) ? value : [value]
  if (!items.length) throw new Error('没有找到节点')
  return items.map(asProxy)
}

/** One-line summary for the node list. */
export function nodeSummary(config: Record<string, unknown>): string {
  const type = String(config.type ?? '').toLowerCase()
  if (type === 'tailscale') {
    const control = typeof config['control-url'] === 'string' && config['control-url'] ? String(config['control-url']).replace(/^https?:\/\//, '') : 'Tailscale 官方控制服务器'
    const exit = config['exit-node'] ? ` · 出口节点 ${String(config['exit-node'])}` : ''
    return `${control}${exit}`
  }
  if (Array.isArray(config.peers)) return `${config.peers.length} 个 Peer`
  if (config.server) return `${String(config.server)}${config.port ? `:${String(config.port)}` : ''}`
  return ''
}
