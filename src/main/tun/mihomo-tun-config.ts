import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, type Node } from 'yaml'
import { isIP } from 'node:net'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import { SECRET_PATTERN } from '../kernel/mihomo-config'
import { buildProfileKernelConfig } from '../kernel/profile-kernel-config'
import type { CoreSettings } from '../../shared/core-settings'
import type { GeodataSettings } from '../../shared/geodata'
import type { TunConfigModel } from '../../shared/tun-config'
import { EMPTY_TUN_CONFIG, buildTunBlock, isValidDnsHijackEntry, isValidTunMtu, isValidTunRouteAddress } from '../../shared/tun-config'

export type MihomoTunStack = 'mixed' | 'system' | 'gvisor'

export interface MihomoTunConfigOptions {
  mixedPort: number
  httpPort?: number
  socksPort?: number
  controllerPort: number
  controllerHost?: '127.0.0.1' | '0.0.0.0'
  allowLan?: boolean
  controllerPanel?: boolean
  secret: string
  device: string
  stack?: MihomoTunStack
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug'
  /** Optional typed TUN config model. When present its fields override the safe
   *  defaults and are folded into the `tun:` block the owned adapter enables. */
  tunConfig?: TunConfigModel
  /** Start the privileged core with TUN dormant; it can then be enabled on the
   *  same process through the authenticated controller. */
  tunEnabled?: boolean
}

const PORT_MIN = 1024
const PORT_MAX = 65535
const DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const STACKS = new Set<MihomoTunStack>(['mixed', 'system', 'gvisor'])
const LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info', 'debug'])
const TOP_KEYS = new Set([
  'port', 'socks-port', 'mixed-port', 'allow-lan', 'bind-address', 'mode', 'log-level', 'ipv6',
  'external-controller', 'secret', 'external-ui', 'external-ui-url', 'external-ui-name', 'tun', 'dns', 'rules'
])
const REQUIRED_TOP_KEYS = new Set([...TOP_KEYS].filter((key) => !['port', 'socks-port', 'external-ui', 'external-ui-url', 'external-ui-name'].includes(key)))
const TUN_KEYS = new Set([
  'enable', 'device', 'stack', 'auto-route', 'auto-detect-interface',
  'strict-route', 'dns-hijack'
])
/** Configurable TUN keys: only validated when present; never required. */
const OPTIONAL_TUN_KEYS = new Set(['mtu', 'route-address', 'route-exclude-address'])
const ALLOW_TUN_KEYS = new Set([...TUN_KEYS, ...OPTIONAL_TUN_KEYS])
const DNS_KEYS = new Set(['enable', 'enhanced-mode', 'fake-ip-range', 'fake-ip-filter', 'nameserver'])

function invalid(message: string): never {
  throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, message)
}

function assertPort(value: number, label: string): void {
  if (!Number.isInteger(value) || value < PORT_MIN || value > PORT_MAX) {
    invalid(`${label} must be an integer between ${PORT_MIN} and ${PORT_MAX}`)
  }
}

/**
 * Generate the only supported Phase 9B bootstrap profile. No I/O is performed.
 *
 * When {@link MihomoTunConfigOptions.tunConfig} is present its fields are folded
 * into the `tun:` block (device, stack, mtu, auto-route, auto-detect-interface,
 * strict-route, dns-hijack and the optional route CIDR lists); otherwise the
 * conservative safe defaults are emitted unchanged. Every generated profile,
 * regardless of source, must still pass {@link mihomoTunConfigErrors}.
 */
/**
 * Resolve the effective `tun.device` (adapter identity).
 *
 * The brand-derived intent (e.g. `<brand> TUN`) is the DEFAULT; the persisted TUN
 * config model overrides it only when the user actually customized the device —
 * the shared stock default (`EMPTY_TUN_CONFIG.device`) is treated as "unset",
 * otherwise every install would silently run with the generic `Mihomo` adapter
 * name no matter what the app intended.
 */
function resolveDevice(model: TunConfigModel | undefined, fallback: string): string {
  if (!model) return fallback
  return model.device === EMPTY_TUN_CONFIG.device ? fallback : model.device
}

export function generateMihomoTunConfig(options: MihomoTunConfigOptions): string {
  assertPort(options.mixedPort, 'mixed-port')
  assertPort(options.controllerPort, 'external-controller port')
  if (options.mixedPort === options.controllerPort) invalid('controller and mixed ports must differ')
  const optionalPorts = [options.httpPort ?? 0, options.socksPort ?? 0]
  for (const [index, port] of optionalPorts.entries()) {
    if (port !== 0) assertPort(port, index === 0 ? 'HTTP port' : 'SOCKS port')
  }
  const activePorts = [options.mixedPort, options.controllerPort, ...optionalPorts].filter((port) => port !== 0)
  if (new Set(activePorts).size !== activePorts.length) invalid('listener ports must differ')
  if (!SECRET_PATTERN.test(options.secret)) invalid('secret must be a 64-character lowercase hex string')
  const logLevel = options.logLevel ?? 'info'
  if (!LOG_LEVELS.has(logLevel)) invalid(`unsupported log level: ${logLevel}`)

  const model = options.tunConfig
  const device = resolveDevice(model, options.device)
  if (!DEVICE_PATTERN.test(device)) invalid('device contains unsupported characters or length')
  const stack = model?.stack ?? options.stack ?? 'mixed'
  if (!STACKS.has(stack)) invalid(`unsupported TUN stack: ${stack}`)

  const tunLines = [
    'tun:',
    `  enable: ${options.tunEnabled ?? true}`,
    `  device: ${device}`,
    `  stack: ${stack}`
  ]
  if (model && isValidTunMtu(model.mtu)) tunLines.push(`  mtu: ${model.mtu}`)
  tunLines.push(
    `  auto-route: ${model ? model.autoRoute : true}`,
    `  auto-detect-interface: ${model ? model.autoDetectInterface : true}`,
    `  strict-route: ${model ? model.strictRoute : false}`,
    '  dns-hijack:',
    ...(model ? model.dnsHijack : ['any:53']).map((entry) => `    - ${entry}`)
  )
  if (model && model.routeAddress.length > 0) {
    tunLines.push('  route-address:')
    for (const cidr of model.routeAddress) tunLines.push(`    - ${cidr}`)
  }
  if (model && model.routeExcludeAddress.length > 0) {
    tunLines.push('  route-exclude-address:')
    for (const cidr of model.routeExcludeAddress) tunLines.push(`    - ${cidr}`)
  }

  const text = [
    ...(options.httpPort ? [`port: ${options.httpPort}`] : []),
    ...(options.socksPort ? [`socks-port: ${options.socksPort}`] : []),
    `mixed-port: ${options.mixedPort}`,
    `allow-lan: ${options.allowLan ?? false}`,
    `bind-address: ${options.allowLan ? "'*'" : '127.0.0.1'}`,
    'mode: direct',
    `log-level: ${logLevel}`,
    'ipv6: false',
    `external-controller: ${options.controllerHost ?? '127.0.0.1'}:${options.controllerPort}`,
    `secret: ${options.secret}`,
    ...(options.controllerPanel ? [
      'external-ui: ui',
      'external-ui-name: metacubexd',
      'external-ui-url: https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip'
    ] : []),
    ...tunLines,
    'dns:',
    '  enable: true',
    '  enhanced-mode: fake-ip',
    '  fake-ip-range: 198.18.0.1/16',
    '  fake-ip-filter:',
    // Quote glob entries: a leading `*` is a YAML alias token and would be
    // rejected by the no-alias validator.
    ...TUN_DEFAULT_FAKE_IP_FILTER.map((entry) => `    - ${JSON.stringify(entry)}`),
    '  nameserver:',
    '    - system',
    'rules:',
    '  - MATCH,DIRECT',
    ''
  ].join('\n')
  const errors = mihomoTunConfigErrors(text)
  if (errors.length > 0) invalid(`generated TUN config failed validation: ${errors.join('; ')}`)
  return text
}

/** Strict validation for generated or persisted Phase 9B profiles. */
export function mihomoTunConfigErrors(text: string): string[] {
  const errors: string[] = []
  const doc = parseDocument(text, { uniqueKeys: true })
  for (const error of doc.errors) errors.push(`YAML parse error: ${error.message.split('\n')[0]}`)
  if (!isMap(doc.contents)) return [...errors, 'config must be a YAML mapping']
  scanUnsafeNodes(doc.contents, errors)
  const root = mapping(doc.contents, TOP_KEYS, 'config', errors)
  requireExactKeys(root, REQUIRED_TOP_KEYS, 'config', errors)

  scalarMatches(root, 'allow-lan', value => typeof value === 'boolean', errors)
  scalarMatches(root, 'bind-address', value => value === '127.0.0.1' || value === '*', errors)
  scalarEquals(root, 'mode', 'direct', errors)
  scalarEquals(root, 'ipv6', false, errors)
  scalarMatches(root, 'mixed-port', value => typeof value === 'number' && Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX, errors)
  for (const key of ['port', 'socks-port']) {
    if (root.has(key)) scalarMatches(root, key, value => typeof value === 'number' && Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX, errors)
  }
  scalarMatches(root, 'external-controller', value => typeof value === 'string' && /^(?:127\.0\.0\.1|0\.0\.0\.0):(?:[1-9]\d*)$/.test(value), errors)
  scalarMatches(root, 'secret', value => typeof value === 'string' && SECRET_PATTERN.test(value), errors)
  scalarMatches(root, 'log-level', value => typeof value === 'string' && LOG_LEVELS.has(value), errors)
  if (root.has('external-ui') || root.has('external-ui-name') || root.has('external-ui-url')) {
    scalarEquals(root, 'external-ui', 'ui', errors)
    scalarEquals(root, 'external-ui-name', 'metacubexd', errors)
    scalarEquals(root, 'external-ui-url', 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip', errors)
  }

  const tunNode = root.get('tun')
  if (!isMap(tunNode)) errors.push('tun must be a mapping')
  else {
    const tun = mapping(tunNode, ALLOW_TUN_KEYS, 'tun', errors)
    requireExactKeys(tun, TUN_KEYS, 'tun', errors)
    scalarMatches(tun, 'enable', value => typeof value === 'boolean', errors, 'tun.enable must be a boolean')
    // auto-route / auto-detect-interface / strict-route are runtime-tunable via
    // the TUN config model; only their type is constrained here.
    scalarMatches(tun, 'auto-route', value => typeof value === 'boolean', errors, 'auto-route must be a boolean')
    scalarMatches(tun, 'auto-detect-interface', value => typeof value === 'boolean', errors, 'auto-detect-interface must be a boolean')
    scalarMatches(tun, 'strict-route', value => typeof value === 'boolean', errors, 'strict-route must be a boolean')
    scalarMatches(tun, 'device', value => typeof value === 'string' && DEVICE_PATTERN.test(value), errors)
    scalarMatches(tun, 'stack', value => typeof value === 'string' && STACKS.has(value as MihomoTunStack), errors)
    if (!tun.has('dns-hijack')) errors.push('missing tun key: dns-hijack')
    else {
      const hijack = tun.get('dns-hijack')
      if (!isSeq(hijack) || hijack.items.length === 0) errors.push('tun.dns-hijack must be a non-empty sequence')
      else for (const item of hijack.items) {
        if (!isScalar(item) || !isValidDnsHijackEntry(nodeText(item))) errors.push(`invalid tun.dns-hijack entry: ${nodeText(item)}`)
      }
    }
    if (tun.has('mtu')) scalarMatches(tun, 'mtu', value => typeof value === 'number' && isValidTunMtu(value), errors, 'mtu must be an integer between 576 and 65535')
    if (tun.has('route-address')) validateRouteList(tun.get('route-address'), 'route-address', errors)
    if (tun.has('route-exclude-address')) validateRouteList(tun.get('route-exclude-address'), 'route-exclude-address', errors)
  }

  const dnsNode = root.get('dns')
  if (!isMap(dnsNode)) errors.push('dns must be a mapping')
  else {
    const dns = mapping(dnsNode, DNS_KEYS, 'dns', errors)
    requireExactKeys(dns, DNS_KEYS, 'dns', errors)
    scalarEquals(dns, 'enable', true, errors)
    scalarEquals(dns, 'enhanced-mode', 'fake-ip', errors)
    scalarEquals(dns, 'fake-ip-range', '198.18.0.1/16', errors)
    const filter = dns.get('fake-ip-filter')
    if (!isSeq(filter) || filter.items.length === 0) {
      errors.push('dns.fake-ip-filter must be a non-empty sequence')
    } else {
      for (const item of filter.items) {
        if (!isScalar(item) || typeof nodeText(item) !== 'string' || nodeText(item).length === 0) {
          errors.push('dns.fake-ip-filter entries must be non-empty strings')
        }
      }
    }
    sequenceEquals(dns.get('nameserver'), ['system'], 'dns.nameserver', errors)
  }
  sequenceEquals(root.get('rules'), ['MATCH,DIRECT'], 'rules', errors)
  return [...new Set(errors)]
}

export function assertMihomoTunConfig(text: string): void {
  const errors = mihomoTunConfigErrors(text)
  if (errors.length > 0) invalid(`unsafe TUN config: ${errors.join('; ')}`)
}

function scanUnsafeNodes(node: Node, errors: string[]): void {
  if (isAlias(node)) errors.push('YAML aliases are not allowed')
  if ('tag' in node && node.tag !== undefined) errors.push('YAML tags are not allowed')
  if (isMap(node)) for (const pair of node.items) {
    if (pair.key) scanUnsafeNodes(pair.key as Node, errors)
    if (pair.value) scanUnsafeNodes(pair.value as Node, errors)
  }
  if (isSeq(node)) for (const item of node.items) if (item) scanUnsafeNodes(item as Node, errors)
}

function mapping(node: Node, allowed: Set<string>, label: string, errors: string[]): Map<string, Node> {
  const result = new Map<string, Node>()
  if (!isMap(node)) return result
  for (const pair of node.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !pair.value) {
      errors.push(`${label} keys must be scalar strings with values`)
      continue
    }
    const key = pair.key.value
    if (!allowed.has(key)) errors.push(`unknown ${label} key: ${key}`)
    if (result.has(key)) errors.push(`duplicate ${label} key: ${key}`)
    result.set(key, pair.value as Node)
  }
  return result
}

function requireExactKeys(values: Map<string, Node>, required: Set<string>, label: string, errors: string[]): void {
  for (const key of required) if (!values.has(key)) errors.push(`missing ${label} key: ${key}`)
}

function scalarEquals(values: Map<string, Node>, key: string, expected: unknown, errors: string[]): void {
  scalarMatches(values, key, value => value === expected, errors, `${key} must equal ${String(expected)}`)
}

function scalarMatches(values: Map<string, Node>, key: string, test: (value: unknown) => boolean, errors: string[], message = `${key} has an invalid value`): void {
  const node = values.get(key)
  if (!isScalar(node) || !test(node.value)) errors.push(message)
}

function sequenceEquals(node: Node | undefined, expected: string[], label: string, errors: string[]): void {
  if (!isSeq(node) || node.items.length !== expected.length || node.items.some((item, index) => !isScalar(item) || item.value !== expected[index])) {
    errors.push(`${label} must contain exactly [${expected.join(', ')}]`)
  }
}

function nodeText(node: unknown): string {
  if (!isScalar(node)) return ''
  const value = node.value
  return value == null ? '' : String(value)
}

function validateRouteList(node: Node | undefined, label: string, errors: string[]): void {
  if (!isSeq(node) || node.items.length === 0) {
    errors.push(`${label} must be a non-empty sequence`)
    return
  }
  for (const item of node.items) {
    if (!isScalar(item) || !isValidTunRouteAddress(String(item.value))) {
      errors.push(`invalid ${label} entry: ${nodeText(item)}`)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Proxied TUN profile (real subscription content)                             */
/* -------------------------------------------------------------------------- */

/**
 * The service enforces a hard 2 MiB ceiling on the submitted profile
 * (`maxProfileBytes` in native/tun-service/protocol.go). Real subscriptions sit
 * below it when `rule-providers` / `proxy-providers` remain remote URLs, while
 * still leaving room for sizeable inline rules. Fail with a legible message
 * instead of letting the service close the pipe without a response.
 */
export const TUN_PROFILE_MAX_BYTES = 2 * 1024 * 1024

/**
 * Hosts kept on real IPs under fake-ip mode, clash-party's shipped default
 * verbatim (`DEFAULT_MIHOMO_DNS_CONFIG.fake-ip-filter`). The leading bare `*`
 * only matches dot-less single-label names in mihomo's domain trie — it does
 * NOT disable fake-ip for regular domains, so LAN names, NTP servers and
 * connectivity probes resolve to real addresses while everything else still
 * gets a fake-ip. Only injected when the profile omits its own filter so the
 * user's routing intent is preserved.
 */
const TUN_DEFAULT_FAKE_IP_FILTER = [
  '*',
  '+.lan',
  '+.local',
  'time.*.com',
  'ntp.*.com',
  '+.market.xiaomi.com'
] as const

/**
 * Top-level keys that must never reach the elevated child, mirroring the
 * service-side blacklist. `buildProfileKernelConfig` already strips the extra
 * inbounds and controller variants for the main kernel; the rest are handled here
 * because this profile runs as SYSTEM:
 *
 * - `tunnels` binds arbitrary local ports and forwards them to arbitrary hosts.
 * - the external UI family is sanitized by the profile builder and separately
 *   restricted to the managed MetaCubeXD source and contained `ui` directory.
 * - `ntp.write-to-system` lets the SYSTEM process set the machine clock.
 * - `external-controller-cors` widens who may reach the controller.
 */
const FORBIDDEN_TOP_KEYS = [
  'redir-port', 'tproxy-port', 'listeners', 'tunnels',
  'external-controller-unix', 'external-controller-pipe', 'external-controller-tls',
  'external-controller-routing-mark', 'external-controller-cors', 'external-doh-server',
  'ntp',
  // Legacy standalone inbound servers. The service refuses these too (protocol.go
  // forbiddenTopKeys) — the lists must stay in lockstep so a subscription that
  // carries one is stripped here instead of failing opaquely at the service.
  'ss-config', 'vmess-config', 'tuic-server'
] as const

/** Sections whose entries carry a `path` mihomo WRITES downloaded content to. */
const PROVIDER_SECTIONS = ['proxy-providers', 'rule-providers'] as const

/**
 * Confine a provider `path` to the state directory. An absolute path or a `..`
 * escape would be an arbitrary file write performed by a SYSTEM-privileged
 * process. Returns null when the path is acceptable.
 */
function providerPathError(path: unknown): string | null {
  if (typeof path !== 'string' || path.trim().length === 0) return 'must be a non-empty string'
  if (/^[/\\]/.test(path) || /^[A-Za-z]:/.test(path)) return 'must be relative to the state directory'
  if (path.includes(':')) return 'must not name a drive or alternate stream'
  if (path.replace(/\\/g, '/').split('/').includes('..')) return 'must not traverse outside the state directory'
  return null
}

/** Collapse a provider name into a single safe filename component. */
function safeProviderFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'provider'
}

/**
 * Add literal proxy endpoint IPs to mihomo's TUN route exclusions.
 *
 * A proxy tunnel cannot carry the socket used to establish itself. Mihomo's
 * automatic interface detection normally avoids that loop, but a route refresh
 * or another VPN/WFP filter can still briefly steer a literal endpoint back into
 * TUN. clash-party applies the same protection for its Smart path; doing it at
 * the app's final privileged-profile boundary protects every core variant while
 * leaving hostname endpoints and provider-managed nodes untouched.
 */
function excludeLiteralProxyServers(
  data: Record<string, unknown>,
  tunBlock: Record<string, unknown>
): void {
  const proxies = data.proxies
  if (!Array.isArray(proxies)) return

  const existing = Array.isArray(tunBlock['route-exclude-address'])
    ? tunBlock['route-exclude-address'].filter((entry): entry is string => typeof entry === 'string')
    : []
  const normalized = new Set(existing.map((entry) => entry.trim().toLowerCase()))
  let changed = false

  for (const proxy of proxies) {
    if (typeof proxy !== 'object' || proxy === null || Array.isArray(proxy)) continue
    const raw = (proxy as Record<string, unknown>).server
    if (typeof raw !== 'string' && typeof raw !== 'number') continue
    const host = String(raw).trim().replace(/^\[(.*)\]$/, '$1').toLowerCase()
    const version = isIP(host)
    if (version === 0) continue
    const cidr = `${host}/${version === 4 ? 32 : 128}`
    if (normalized.has(host) || normalized.has(cidr)) continue
    existing.push(cidr)
    normalized.add(cidr)
    changed = true
  }

  if (changed) tunBlock['route-exclude-address'] = existing
}

export interface ProxiedTunConfigOptions {
  /** The ACTIVE profile document, already through overrides/DNS/sniffer. */
  document: string
  mixedPort: number
  httpPort?: number
  socksPort?: number
  controllerPort: number
  controllerHost?: '127.0.0.1' | '0.0.0.0'
  allowLan?: boolean
  controllerPanel?: boolean
  secret: string
  device: string
  stack?: MihomoTunStack
  tunConfig?: TunConfigModel
  core?: CoreSettings
  geodata?: GeodataSettings
  /** Defaults to true for compatibility with the legacy start-on-enable path. */
  tunEnabled?: boolean
}

/**
 * Build a TUN profile that actually proxies: the user's proxies, groups,
 * providers and rules are preserved and mihomo owns the adapter.
 *
 * The safety transform is NOT reimplemented here — {@link buildProfileKernelConfig}
 * is reused verbatim, so this path inherits exactly the same neutralisation the
 * main kernel gets (extra inbounds, unauthenticated controller variants and
 * `dns.listen` stripped; loopback controller, `allow-lan:false`,
 * `bind-address:127.0.0.1`, caller's secret and `mode:rule` forced). The only
 * deliberate divergence is the `tun:` block: that transform drops `tun` because
 * the main kernel must stay loopback-only, whereas this profile exists precisely
 * to enable it.
 */
export function generateProxiedTunConfig(options: ProxiedTunConfigOptions): string {
  assertPort(options.mixedPort, 'mixed-port')
  assertPort(options.controllerPort, 'external-controller port')
  if (options.mixedPort === options.controllerPort) invalid('controller and mixed ports must differ')
  if (!SECRET_PATTERN.test(options.secret)) invalid('secret must be a 64-character lowercase hex string')

  const model = options.tunConfig
  const device = resolveDevice(model, options.device)
  if (!DEVICE_PATTERN.test(device)) invalid('device contains unsupported characters or length')
  const stack = model?.stack ?? options.stack ?? 'mixed'
  if (!STACKS.has(stack)) invalid(`unsupported TUN stack: ${stack}`)

  // Reuse the main-kernel safety pass (content preserved, host-network mutation
  // neutralised, app-critical listener/auth keys forced).
  const safeText = buildProfileKernelConfig(options.document, {
    mixedPort: options.mixedPort,
    httpPort: options.httpPort,
    socksPort: options.socksPort,
    controllerPort: options.controllerPort,
    controllerHost: options.controllerHost,
    allowLan: options.allowLan,
    controllerPanel: options.controllerPanel,
    secret: options.secret,
    core: options.core,
    geodata: options.geodata
  })

  const parsed = parseDocument(safeText, { merge: true, uniqueKeys: true })
  if (parsed.errors.length > 0) {
    invalid(`配置解析失败：${parsed.errors.map((e) => e.message.split('\n')[0]).join('；')}`)
  }
  const data = parsed.toJS() as Record<string, unknown>

  // Strip rather than reject: `buildProfileKernelConfig` has already replaced
  // subscription-provided external UI values with the optional managed panel.
  // The remaining forbidden keys are capabilities that must never reach the
  // privileged child.
  for (const key of FORBIDDEN_TOP_KEYS) delete data[key]

  // A provider `path` is only a cache location, but mihomo WRITES downloaded
  // content there as SYSTEM, so an absolute or `..`-escaping path is an arbitrary
  // file write. Rewrite an unsafe one to a deterministic contained location rather
  // than rejecting the whole subscription: the provider keeps working and the
  // write stays inside the state directory.
  for (const section of PROVIDER_SECTIONS) {
    const raw = data[section]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      if (record.path === undefined) continue
      if (providerPathError(record.path) !== null) {
        record.path = `./${section}/${safeProviderFileName(name)}.yaml`
      }
    }
  }

  // `tun` is re-added on top of the transform that intentionally removed it.
  const tunEnabled = options.tunEnabled ?? true
  const tunBlock: Record<string, unknown> = model
    ? { enable: tunEnabled, ...buildTunBlock({ ...model, device, stack }) }
    : {
        enable: tunEnabled,
        device,
        stack,
        'auto-route': true,
        'auto-detect-interface': true,
        'strict-route': false,
        'dns-hijack': ['any:53']
      }
  excludeLiteralProxyServers(data, tunBlock)
  data.tun = tunBlock

  // DNS takeover follows clash-party's `controlDns=false` default: the profile
  // is authoritative and this pass never force-enables the DNS module. When the
  // final document has no enabled DNS, port-53 hijacking is cleared — a hijack
  // list without a live DNS module would blackhole every hostname (clash-party
  // applies the same rule in its final-config merge). When the DNS module IS
  // enabled (the app's DNS enhancement already merged its block into the
  // document, or the subscription ships its own), only the fake-ip defaults the
  // profile omitted are filled in, mirroring clash-party's controlled defaults.
  const existingDns = data.dns
  const dns: Record<string, unknown> =
    typeof existingDns === 'object' && existingDns !== null && !Array.isArray(existingDns)
      ? { ...(existingDns as Record<string, unknown>) }
      : {}
  if (dns.enable !== true) {
    // No DNS takeover: the profile's disabled/absent dns block passes through
    // (Party deletes a controlled dns block in this state) and port-53
    // hijacking is cleared so lookups flow through the tunnel as ordinary
    // connections instead of hitting an unprepared DNS module.
    tunBlock['dns-hijack'] = []
    if (Object.keys(dns).length > 0) data.dns = dns
  } else {
    data.dns = dns
    if (dns['enhanced-mode'] === undefined) dns['enhanced-mode'] = 'fake-ip'
    if (!Array.isArray(dns.nameserver) || dns.nameserver.length === 0) {
      dns.nameserver = ['system']
    }
    // Keep game-/NTP-relevant domains out of fake-ip space only when the profile
    // omitted this key. An explicitly empty list is still user routing intent: it
    // asks mihomo to allocate fake IPs for every domain and must not be rewritten.
    if (dns['enhanced-mode'] === 'fake-ip' && dns['fake-ip-range'] === undefined) {
      dns['fake-ip-range'] = '198.18.0.1/16'
    }
    if (dns['enhanced-mode'] === 'fake-ip' && !Object.prototype.hasOwnProperty.call(dns, 'fake-ip-filter')) {
      dns['fake-ip-filter'] = [...TUN_DEFAULT_FAKE_IP_FILTER]
    }
  }

  const text = stringify(data)
  const errors = proxiedTunConfigErrors(text)
  if (errors.length > 0) invalid(`generated TUN config failed validation: ${errors.join('; ')}`)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > TUN_PROFILE_MAX_BYTES) {
    invalid(
      `TUN 配置为 ${bytes} 字节，超过特权服务的 ${TUN_PROFILE_MAX_BYTES} 字节上限。` +
        '请改用 rule-providers/proxy-providers 引用规则集，而不要将其内联进配置。'
    )
  }
  return text
}

/**
 * Validate a proxied TUN profile against the NON-NEGOTIABLE invariants only.
 *
 * Deliberately weaker than {@link mihomoTunConfigErrors}: proxies, groups,
 * providers, rules and a full `dns` block are legitimate content here, so there
 * is no exact top-level allowlist. What stays enforced is what the privileged
 * service also re-checks independently — no public bind, no unauthenticated
 * controller surface, no extra inbound, no alias/tag tricks, TUN actually on.
 */
export function proxiedTunConfigErrors(text: string): string[] {
  const errors: string[] = []
  const doc = parseDocument(text, { merge: true, uniqueKeys: true })
  for (const error of doc.errors) errors.push(`YAML parse error: ${error.message.split('\n')[0]}`)
  if (!isMap(doc.contents)) return [...errors, 'config must be a YAML mapping']
  scanUnsafeNodes(doc.contents, errors)

  let data: Record<string, unknown>
  try {
    data = doc.toJS() as Record<string, unknown>
  } catch (error) {
    return [...errors, `config could not be resolved: ${(error as Error).message.split('\n')[0]}`]
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [...errors, 'config must be a YAML mapping']
  }

  for (const key of FORBIDDEN_TOP_KEYS) {
    if (key in data) errors.push(`forbidden key for a privileged profile: ${key}`)
  }
  // Provider paths are WRITE targets for a SYSTEM-privileged process.
  for (const section of PROVIDER_SECTIONS) {
    const raw = data[section]
    if (raw === undefined) continue
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`${section} must be a mapping`)
      continue
    }
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${section}.${name} must be a mapping`)
        continue
      }
      const path = (entry as Record<string, unknown>).path
      if (path === undefined) continue
      const problem = providerPathError(path)
      if (problem) errors.push(`${section}.${name}.path ${problem}`)
    }
  }
  if (typeof data['allow-lan'] !== 'boolean') errors.push('allow-lan must be a boolean')
  if (typeof data['external-controller'] !== 'string' || !/^(?:127\.0\.0\.1|0\.0\.0\.0):(?:[1-9]\d*)$/.test(data['external-controller'])) {
    errors.push('external-controller must use a supported listen address')
  }
  const uiKeys = ['external-ui', 'external-ui-name', 'external-ui-url'] as const
  const hasUi = uiKeys.some((key) => key in data)
  if (hasUi && (
    data['external-ui'] !== 'ui' ||
    data['external-ui-name'] !== 'metacubexd' ||
    data['external-ui-url'] !== 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip'
  )) errors.push('external-ui settings must use the managed dashboard')
  if (typeof data.secret !== 'string' || !SECRET_PATTERN.test(data.secret)) {
    errors.push('secret must be a 64-character lowercase hex string')
  }
  const mixedPort = data['mixed-port']
  if (typeof mixedPort !== 'number' || !Number.isInteger(mixedPort) || mixedPort < PORT_MIN || mixedPort > PORT_MAX) {
    errors.push('mixed-port is outside the allowed range')
  }
  const listenerPorts = [mixedPort]
  for (const key of ['port', 'socks-port']) {
    const port = data[key]
    if (port === undefined) continue
    if (typeof port !== 'number' || !Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
      errors.push(`${key} is outside the allowed range`)
    } else listenerPorts.push(port)
  }
  const controllerMatch = typeof data['external-controller'] === 'string'
    ? /^(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)$/.exec(data['external-controller'])
    : null
  if (controllerMatch) listenerPorts.push(Number(controllerMatch[1]))
  if (listenerPorts.every((port) => typeof port === 'number') && new Set(listenerPorts).size !== listenerPorts.length) {
    errors.push('listener ports must differ')
  }

  const tun = data.tun
  if (typeof tun !== 'object' || tun === null || Array.isArray(tun)) {
    errors.push('tun must be a mapping')
  } else {
    const block = tun as Record<string, unknown>
    if (typeof block.enable !== 'boolean') errors.push('tun.enable must be a boolean')
    if (typeof block.device !== 'string' || !DEVICE_PATTERN.test(block.device)) errors.push('tun.device is invalid')
    if (typeof block.stack !== 'string' || !STACKS.has(block.stack as MihomoTunStack)) errors.push('tun.stack is invalid')
    if (block.mtu !== undefined && (typeof block.mtu !== 'number' || !isValidTunMtu(block.mtu))) {
      errors.push('tun.mtu must be an integer between 576 and 65535')
    }
    const hijack = block['dns-hijack']
    if (!Array.isArray(hijack)) errors.push('tun.dns-hijack must be a sequence')
    else {
      for (const entry of hijack) {
        if (typeof entry !== 'string' || !isValidDnsHijackEntry(entry)) errors.push(`invalid tun.dns-hijack entry: ${String(entry)}`)
      }
      // clash-party parity: port-53 hijacking only exists when a live DNS module
      // can answer the hijacked queries. An empty list is legal exactly when the
      // final config leaves the DNS module off.
      const dnsBlock = data.dns
      const dnsEnabled =
        typeof dnsBlock === 'object' && dnsBlock !== null && !Array.isArray(dnsBlock) &&
        (dnsBlock as Record<string, unknown>).enable === true
      if (hijack.length > 0 && !dnsEnabled) {
        errors.push('tun.dns-hijack must be empty when dns.enable is not true')
      }
    }
    for (const [key, label] of [['route-address', 'tun.route-address'], ['route-exclude-address', 'tun.route-exclude-address']] as const) {
      const list = block[key]
      if (list === undefined) continue
      if (!Array.isArray(list) || list.length === 0) errors.push(`${label} must be a non-empty sequence`)
      else for (const entry of list) {
        if (typeof entry !== 'string' || !isValidTunRouteAddress(entry)) errors.push(`invalid ${label} entry: ${String(entry)}`)
      }
    }
    // A TUN device without auto-route and without explicit routes is a silent
    // traffic black hole: the interface exists, DNS may even answer, but no
    // traffic is ever steered into it. Refuse the combination up front instead
    // of shipping a support-nightmare "TUN enabled but the network is down" state.
    if (block['auto-route'] === false && block['auto-detect-interface'] === false) {
      const routeAddress = block['route-address']
      if (!Array.isArray(routeAddress) || routeAddress.length === 0) {
        errors.push('tun.route-address is required when both auto-route and auto-detect-interface are disabled')
      }
    }
  }

  const dns = data.dns
  if (dns === undefined) {
    // clash-party parity: a profile without a dns block is legitimate — mihomo
    // runs its internal resolver and TUN must not hijack port 53 (checked in
    // the tun block above).
  } else if (typeof dns !== 'object' || dns === null || Array.isArray(dns)) {
    errors.push('dns must be a mapping')
  } else {
    const block = dns as Record<string, unknown>
    // clash-party parity: the DNS module may stay off; only an ENABLED module is
    // held to the mode constraint. The dns-hijack pairing rule lives in the tun
    // block validation above.
    if (block.enable === true) {
      if (block['enhanced-mode'] !== 'fake-ip' && block['enhanced-mode'] !== 'redir-host') {
        errors.push('dns.enhanced-mode must equal fake-ip or redir-host')
      }
    }
    if ('listen' in block) errors.push('forbidden key for a privileged profile: dns.listen')
    if ('fake-ip-filter' in block) {
      const filter = block['fake-ip-filter']
      if (!Array.isArray(filter)) errors.push('dns.fake-ip-filter must be a sequence')
      else for (const entry of filter) {
        if (typeof entry !== 'string' || entry.length === 0) {
          errors.push('dns.fake-ip-filter entries must be non-empty strings')
        }
      }
    }
  }

  return [...new Set(errors)]
}

/** Throwing form of {@link proxiedTunConfigErrors}. */
export function assertProxiedTunConfig(text: string): void {
  const errors = proxiedTunConfigErrors(text)
  if (errors.length > 0) invalid(`unsafe TUN config: ${errors.join('; ')}`)
}
