import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import { SECRET_PATTERN } from '../kernel/mihomo-config'
import type { TunConfigModel } from '../../shared/tun-config'
import { isValidDnsHijackEntry, isValidTunMtu, isValidTunRouteAddress } from '../../shared/tun-config'

export type MihomoTunStack = 'mixed' | 'system' | 'gvisor'

export interface MihomoTunConfigOptions {
  mixedPort: number
  controllerPort: number
  secret: string
  device: string
  stack?: MihomoTunStack
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug'
  /** Optional typed TUN config model. When present its fields override the safe
   *  defaults and are folded into the `tun:` block the owned adapter enables. */
  tunConfig?: TunConfigModel
}

const PORT_MIN = 1024
const PORT_MAX = 65535
const DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const STACKS = new Set<MihomoTunStack>(['mixed', 'system', 'gvisor'])
const LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info', 'debug'])
const TOP_KEYS = new Set([
  'mixed-port', 'allow-lan', 'mode', 'log-level', 'ipv6',
  'external-controller', 'secret', 'tun', 'dns', 'rules'
])
const TUN_KEYS = new Set([
  'enable', 'device', 'stack', 'auto-route', 'auto-detect-interface',
  'strict-route', 'dns-hijack'
])
/** Configurable TUN keys: only validated when present; never required. */
const OPTIONAL_TUN_KEYS = new Set(['mtu', 'route-address', 'route-exclude-address'])
const ALLOW_TUN_KEYS = new Set([...TUN_KEYS, ...OPTIONAL_TUN_KEYS])
const DNS_KEYS = new Set(['enable', 'enhanced-mode', 'fake-ip-range', 'nameserver'])

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
export function generateMihomoTunConfig(options: MihomoTunConfigOptions): string {
  assertPort(options.mixedPort, 'mixed-port')
  assertPort(options.controllerPort, 'external-controller port')
  if (options.mixedPort === options.controllerPort) invalid('controller and mixed ports must differ')
  if (!SECRET_PATTERN.test(options.secret)) invalid('secret must be a 64-character lowercase hex string')
  const logLevel = options.logLevel ?? 'info'
  if (!LOG_LEVELS.has(logLevel)) invalid(`unsupported log level: ${logLevel}`)

  const model = options.tunConfig
  const device = model?.device ?? options.device
  if (!DEVICE_PATTERN.test(device)) invalid('device contains unsupported characters or length')
  const stack = model?.stack ?? options.stack ?? 'mixed'
  if (!STACKS.has(stack)) invalid(`unsupported TUN stack: ${stack}`)

  const tunLines = [
    'tun:',
    '  enable: true',
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
    `mixed-port: ${options.mixedPort}`,
    'allow-lan: false',
    'mode: direct',
    `log-level: ${logLevel}`,
    'ipv6: false',
    `external-controller: 127.0.0.1:${options.controllerPort}`,
    `secret: ${options.secret}`,
    ...tunLines,
    'dns:',
    '  enable: true',
    '  enhanced-mode: fake-ip',
    '  fake-ip-range: 198.18.0.1/16',
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
  requireExactKeys(root, TOP_KEYS, 'config', errors)

  scalarEquals(root, 'allow-lan', false, errors)
  scalarEquals(root, 'mode', 'direct', errors)
  scalarEquals(root, 'ipv6', false, errors)
  scalarMatches(root, 'mixed-port', value => typeof value === 'number' && Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX, errors)
  scalarMatches(root, 'external-controller', value => typeof value === 'string' && /^127\.0\.0\.1:(?:[1-9]\d*)$/.test(value), errors)
  scalarMatches(root, 'secret', value => typeof value === 'string' && SECRET_PATTERN.test(value), errors)
  scalarMatches(root, 'log-level', value => typeof value === 'string' && LOG_LEVELS.has(value), errors)

  const tunNode = root.get('tun')
  if (!isMap(tunNode)) errors.push('tun must be a mapping')
  else {
    const tun = mapping(tunNode, ALLOW_TUN_KEYS, 'tun', errors)
    requireExactKeys(tun, TUN_KEYS, 'tun', errors)
    scalarEquals(tun, 'enable', true, errors)
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
