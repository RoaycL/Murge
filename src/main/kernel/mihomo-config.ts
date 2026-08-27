import { randomBytes } from 'node:crypto'
import { parseDocument, isMap, isScalar, isSeq, isAlias, type Node } from 'yaml'
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
  /** Controller bearer secret (must be a 64-character hex string). */
  secret: string
  /** Outbound mode. Phase 7 pins DIRECT; other modes are rejected. */
  mode?: MihomoMode
  /** Log verbosity. */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug'
}

/** Top-level keys the strict config may contain. Anything else is rejected. */
export const ALLOWED_TOP_LEVEL_KEYS = [
  'mixed-port',
  'allow-lan',
  'mode',
  'log-level',
  'ipv6',
  'external-controller',
  'secret',
  'tun',
  'dns',
  'rules'
] as const

const ALLOWED_TOP_SET = new Set<string>(ALLOWED_TOP_LEVEL_KEYS)
const ALLOWED_LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info', 'debug'])
const ALLOWED_RULES = ['MATCH,DIRECT'] as const

/** Hex secret produced by `randomSecret(32)`; the only accepted secret format. */
export const SECRET_PATTERN = /^[0-9a-f]{64}$/

/** Unprivileged port range: high ports only, never a privileged (<1024) port. */
const MIN_PORT = 1024
const MAX_PORT = 65535

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      `Invalid ${label}: must be an unprivileged integer port between ${MIN_PORT} and ${MAX_PORT}, got ${port}`
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
  if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      'secret must be a 64-character lowercase hex string'
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
  if (!ALLOWED_LOG_LEVELS.has(logLevel)) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      `Unsupported log level: ${logLevel}`
    )
  }

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

const CONTROLLER_PATTERN = /^127\.0\.0\.1:(\d+)$/

/**
 * Collect every violation in `text` as human-readable messages. Returns an empty
 * array when the document satisfies the strict Phase-7 invariants.
 *
 * The document is parsed with a real YAML parser and validated against an exact
 * top-level allowlist: any unknown key, duplicate key, alias, tag, composite key
 * or non-allowlisted rule/member is rejected. This closes the gap where a stray
 * `socks-port`, `listeners`, `hosts`, `profile`, `sniffer`, `proxy-providers` or
 * duplicated `tun`/`dns`/`rules` section could slip past a regex check.
 */
export function mihomoConfigErrors(text: string): string[] {
  const errors: string[] = []
  const doc = parseDocument(text, { uniqueKeys: true })
  for (const err of doc.errors) {
    errors.push(`YAML parse error: ${err.message.split('\n')[0]}`)
  }
  if (!isMap(doc.contents)) {
    errors.push('config must be a YAML mapping at the top level')
    return errors
  }

  const seen = new Set<string>()
  for (const item of doc.contents.items) {
    const keyNode = item.key
    const valueNode = item.value
    if (valueNode === null) {
      errors.push('config entries must have a value')
      continue
    }
    if (isAlias(keyNode) || isAlias(valueNode)) {
      errors.push('config must not use YAML aliases')
      continue
    }
    if (!isScalar(keyNode) || typeof keyNode.value !== 'string') {
      errors.push('top-level keys must be plain scalar strings')
      continue
    }
    if (keyNode.tag !== undefined || valueNode.tag !== undefined) {
      errors.push(`key ${keyNode.value} uses a YAML tag, which is not allowed`)
      continue
    }
    const key = keyNode.value
    if (seen.has(key)) {
      errors.push(`duplicate key: ${key}`)
      continue
    }
    seen.add(key)
    if (!ALLOWED_TOP_SET.has(key)) {
      errors.push(`unknown top-level key: ${key}`)
      continue
    }
    errors.push(...collectKeyErrors(key, valueNode))
  }

  for (const req of ALLOWED_TOP_LEVEL_KEYS) {
    if (!seen.has(req)) errors.push(`missing required key: ${req}`)
  }
  return errors
}

function collectKeyErrors(key: string, valueNode: unknown): string[] {
  const errors: string[] = []
  // Boolean false must already be a boolean (not the string "false").
  const isBoolFalse = isScalar(valueNode) && typeof valueNode.value === 'boolean' && valueNode.value === false
  if (!isScalar(valueNode)) {
    if (key === 'tun' || key === 'dns' || key === 'rules') {
      errors.push(...collectNestedErrors(key, valueNode))
    } else {
      errors.push(`${key} must be a scalar value`)
    }
    return errors
  }

  if (key === 'mixed-port') {
    if (typeof valueNode.value !== 'number') errors.push('mixed-port must be a number')
    else if (
      !Number.isInteger(valueNode.value) ||
      valueNode.value < MIN_PORT ||
      valueNode.value > MAX_PORT
    ) {
      errors.push(`mixed-port must be an unprivileged port between ${MIN_PORT} and ${MAX_PORT}`)
    }
  } else if (key === 'allow-lan') {
    if (!isBoolFalse) errors.push('allow-lan must be false')
  } else if (key === 'mode') {
    if (typeof valueNode.value !== 'string' || valueNode.value !== 'direct') {
      errors.push('mode must be direct')
    }
  } else if (key === 'log-level') {
    if (typeof valueNode.value !== 'string' || !ALLOWED_LOG_LEVELS.has(valueNode.value)) {
      errors.push(`log-level must be one of ${[...ALLOWED_LOG_LEVELS].join(', ')}`)
    }
  } else if (key === 'ipv6') {
    if (!isBoolFalse) errors.push('ipv6 must be false')
  } else if (key === 'external-controller') {
    if (typeof valueNode.value !== 'string' || !CONTROLLER_PATTERN.test(valueNode.value)) {
      errors.push('external-controller must be bound to 127.0.0.1')
    } else {
      const port = Number(valueNode.value.match(CONTROLLER_PATTERN)![1])
      if (port < MIN_PORT || port > MAX_PORT) {
        errors.push(`external-controller port must be unprivileged (${MIN_PORT}-${MAX_PORT})`)
      }
    }
  } else if (key === 'secret') {
    if (typeof valueNode.value !== 'string' || !SECRET_PATTERN.test(valueNode.value)) {
      errors.push('secret must be a 64-character lowercase hex string')
    }
  }
  return errors
}

function collectNestedErrors(section: 'tun' | 'dns' | 'rules', valueNode: unknown): string[] {
  const errors: string[] = []
  if (section === 'rules') {
    if (!isSeq(valueNode)) {
      errors.push('rules must be a YAML sequence')
      return errors
    }
    if (valueNode.items.length !== ALLOWED_RULES.length) {
      errors.push(`rules must contain exactly [${ALLOWED_RULES.join(', ')}]`)
      return errors
    }
    for (const item of valueNode.items as Node[]) {
      if (isAlias(item) || item.tag !== undefined || !isScalar(item) || item.value !== 'MATCH,DIRECT') {
        errors.push(`rules must contain only ${ALLOWED_RULES.join(', ')}`)
        return errors
      }
    }
    return errors
  }

  // tun / dns: only `enable: false` is allowed.
  if (!isMap(valueNode)) {
    errors.push(`${section} must be a YAML mapping`)
    return errors
  }
  const seen = new Set<string>()
  for (const item of valueNode.items as { key: Node; value: Node | null }[]) {
    const k = item.key
    const v = item.value
    if (v === null) {
      errors.push(`${section} entries must have a value`)
      continue
    }
    if (isAlias(k) || isAlias(v) || k.tag !== undefined || v.tag !== undefined) {
      errors.push(`${section} must not use aliases or tags`)
      continue
    }
    if (!isScalar(k) || typeof k.value !== 'string') {
      errors.push(`${section} keys must be plain scalar strings`)
      continue
    }
    const nestedKey = k.value
    if (seen.has(nestedKey)) {
      errors.push(`duplicate key in ${section}: ${nestedKey}`)
      continue
    }
    seen.add(nestedKey)
    if (nestedKey !== 'enable') {
      errors.push(`${section} may only contain 'enable'`)
      continue
    }
    if (!isScalar(v) || typeof v.value !== 'boolean' || v.value !== false) {
      errors.push(`${section}.enable must be false`)
    }
  }
  if (!seen.has('enable')) errors.push(`${section}.enable must be false`)
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
 * The validator guarantees a valid secret is a single 64-hex token on its own
 * line, so masking that whole line is enough. As defense in depth, any stray
 * 64-hex token (e.g. from a malformed multi-line document that bypassed the
 * boundary) is also redacted so it can never reach a log or an evidence file.
 */
export function sanitizeMihomoConfig(text: string): string {
  const maskedLine = text.replace(/^(\s*secret:\s*).*$/m, '$1<redacted>')
  return maskedLine.replace(/\b[0-9a-f]{64}\b/g, '<redacted>')
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
