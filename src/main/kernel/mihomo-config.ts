import { randomBytes } from 'node:crypto'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

/**
 * Strict, minimal config document for a controlled mihomo run.
 *
 * This generator emits a config that only listens on loopback, never touches
 * the system network stack, and pins the traffic to DIRECT. It is the security
 * boundary for the real-kernel milestone: it must contain ONLY the keys below,
 * and must never contain any key that could mutate the system proxy, firewall,
 * routes, NICs or the tun stack.
 */

export type MihomoMode = 'direct'

export interface MihomoConfigOptions {
  /** TCP mixed (HTTP+SOCKS) port. */
  mixedPort: number
  /** External controller REST/WebSocket port (loopback only). */
  controllerPort: number
  /** Controller bearer secret. */
  secret: string
  /** Outbound mode. Phase 7 pins DIRECT; other modes are rejected. */
  mode?: MihomoMode
  /** Log verbosity. */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug'
}

/** Keys that would let a config mutate the host network stack. Never emitted. */
const FORBIDDEN_KEYS = [
  'redir-port',
  'tproxy-port',
  'routing-mark',
  'interface-name',
  'auto-route',
  'auto-detect-interface',
  'system-proxy',
  'set-system-proxy',
  'proxy-system',
  'bind-address',
  'lan-serve'
] as const

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      `Invalid ${label}: must be an integer between 1 and 65535, got ${port}`
    )
  }
}

/**
 * Render the strict mihomo config document as YAML text. The emitted document is
 * loopback-only, non-privileged, TUN/DNS disabled, and rules MATCH,DIRECT.
 */
export function generateMihomoConfig(options: MihomoConfigOptions): string {
  const { mixedPort, controllerPort, secret } = options
  assertPort(mixedPort, 'mixed-port')
  assertPort(controllerPort, 'external-controller port')
  if (mixedPort === controllerPort) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      'mixed-port and external-controller port must differ'
    )
  }
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      'secret must be a string of at least 16 characters'
    )
  }
  const mode = options.mode ?? 'direct'
  if (mode !== 'direct') {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      `Unsupported mihomo mode: ${mode}; Phase 7 requires 'direct'`
    )
  }
  const logLevel = options.logLevel ?? 'info'

  return [
    'mixed-port: ' + mixedPort,
    'allow-lan: false',
    'mode: ' + mode,
    'log-level: ' + logLevel,
    'ipv6: false',
    'external-controller: 127.0.0.1:' + controllerPort,
    'secret: ' + secret,
    'tun:',
    '  enable: false',
    'dns:',
    '  enable: false',
    'rules:',
    '  - MATCH,DIRECT',
    ''
  ].join('\n')
}

interface ParsedConfig {
  scalars: Map<string, string>
  hasTunEnableFalse: boolean
  hasDnsEnableFalse: boolean
  hasMatchDirect: boolean
  forbiddenPresent: string[]
}

/** Lightweight, dependency-free parse of the YAML subset we emit. */
function parseConfig(text: string): ParsedConfig {
  const scalars = new Map<string, string>()
  let hasTunEnableFalse = false
  let hasDnsEnableFalse = false
  let hasMatchDirect = false
  const forbiddenPresent: string[] = []
  const forbiddenSet = new Set<string>(FORBIDDEN_KEYS)

  const lines = text.split('\n')
  let section = '' // current top-level key we are inside ('tun' | 'dns' | 'rules' | '')
  let inRules = false
  let consumingRules = false
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    // Top-level key:value scalars and section headers (empty value).
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (scalar && !line.startsWith(' ')) {
      const key = scalar[1]
      const value = scalar[2].trim()
      scalars.set(key, value)
      section = key
      inRules = key === 'rules'
      consumingRules = inRules && value === ''
      continue
    }

    if (consumingRules) {
      const rule = trimmed.match(/^-\s+(.+)$/)
      if (rule) {
        hasMatchDirect ||= rule[1].trim() === 'MATCH,DIRECT'
        continue
      }
    }

    // Nested two-space keys inside a section header.
    const nested = line.match(/^  ([A-Za-z0-9_-]+):\s*(.+)$/)
    if (nested) {
      const key = nested[1]
      const value = nested[2].trim()
      if (section === 'tun' && key === 'enable') hasTunEnableFalse = value === 'false'
      if (section === 'dns' && key === 'enable') hasDnsEnableFalse = value === 'false'
    }
  }

  for (const key of forbiddenSet) {
    if (text.includes(key)) forbiddenPresent.push(key)
  }
  return { scalars, hasTunEnableFalse, hasDnsEnableFalse, hasMatchDirect, forbiddenPresent }
}

/**
 * Collect every violation in `text` as human-readable messages. Returns an empty
 * array when the document satisfies the strict Phase-7 invariants.
 */
export function mihomoConfigErrors(text: string): string[] {
  const errors: string[] = []
  const parsed = parseConfig(text)
  const { scalars } = parsed

  if (parsed.forbiddenPresent.length) {
    errors.push(`config contains forbidden key(s): ${[...new Set(parsed.forbiddenPresent)].join(', ')}`)
  }
  if (!scalars.has('mixed-port')) errors.push('missing required key: mixed-port')
  if (!scalars.has('allow-lan')) errors.push('missing required key: allow-lan')
  if (scalars.get('allow-lan') !== 'false') errors.push('allow-lan must be false')
  if (!scalars.has('mode')) errors.push('missing required key: mode')
  if (scalars.get('mode') !== 'direct') errors.push('mode must be direct')
  if (!scalars.has('log-level')) errors.push('missing required key: log-level')
  if (!scalars.has('ipv6')) errors.push('missing required key: ipv6')
  if (scalars.get('ipv6') !== 'false') errors.push('ipv6 must be false')
  if (!scalars.has('external-controller')) errors.push('missing required key: external-controller')
  const controller = scalars.get('external-controller') ?? ''
  if (controller !== '' && !controller.startsWith('127.0.0.1:')) {
    errors.push('external-controller must be bound to 127.0.0.1')
  }
  if (!scalars.has('secret')) errors.push('missing required key: secret')
  const secret = scalars.get('secret') ?? ''
  if (secret !== '' && secret.length < 16) errors.push('secret must be at least 16 characters')
  if (!parsed.hasTunEnableFalse) errors.push('tun.enable must be false')
  if (!parsed.hasDnsEnableFalse) errors.push('dns.enable must be false')
  if (!parsed.hasMatchDirect) errors.push('rules must contain MATCH,DIRECT')

  return errors
}

/**
 * Assert the document satisfies the strict Phase-7 invariants, throwing a
 * ProtocolError on the first violation.
 */
export function validateMihomoConfigYaml(text: string): void {
  const errors = mihomoConfigErrors(text)
  if (errors.length) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      `Unsafe mihomo config: ${errors.join('; ')}`
    )
  }
}

/**
 * Return a copy of the config text with the controller secret masked, so the
 * document can be shown in evidence or logs without leaking the bearer token.
 */
export function sanitizeMihomoConfig(text: string): string {
  return text.replace(/^(secret:\s*)(\S+)$/m, '$1<redacted>')
}

/** Generate a high-entropy hex secret. Defaults to 32 bytes (64 hex chars). */
export function randomSecret(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 1024) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      `Invalid secret length: ${bytes}`
    )
  }
  return randomBytes(bytes).toString('hex')
}
