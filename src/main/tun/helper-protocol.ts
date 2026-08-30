import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

const MAX_UINT64 = (1n << 64n) - 1n
const REQUEST_ID = /^(?:0|[1-9][0-9]{0,19})$/
const MAC_HEX = /^[0-9a-f]{64}$/
export const HELPER_MAX_PAYLOAD_BYTES = 4096

export const HELPER_OPS = [
  'probe_integrity',
  'create_adapter',
  'apply_network_state',
  'close_creator_handle',
  'snapshot',
  'restore',
  'get_status',
  'health'
] as const

export type HelperOp = (typeof HELPER_OPS)[number]
export type HelperPayload = null | boolean | number | string | HelperPayload[] | { [key: string]: HelperPayload }

export interface HelperCommandEnvelope {
  v: 1
  op: HelperOp
  requestId: string
  mac: string
  payload: HelperPayload
}

export function deriveHelperSessionKey(
  launchSecret: Buffer,
  salt: Buffer,
  peerRole: 'app-client' | 'privileged-helper'
): Buffer {
  try {
    if (launchSecret.length !== 32 || salt.length < 16) invalid('invalid handshake key material')
    return Buffer.from(hkdfSync('sha256', launchSecret, salt, Buffer.from(`murge-tun:${peerRole}`, 'utf8'), 32))
  } finally {
    launchSecret.fill(0)
  }
}

/** In-memory application-level MAC and replay guard; transport remains injected. */
export class HelperMacSession {
  private readonly key: Buffer
  private nextOutgoing = 1n
  private lastIncoming = 0n
  private closed = false

  constructor(sessionKey: Buffer) {
    if (sessionKey.length !== 32) invalid('session key must contain 32 bytes')
    this.key = Buffer.from(sessionKey)
  }

  create(op: HelperOp, payload: HelperPayload): HelperCommandEnvelope {
    this.assertOpen()
    if (this.nextOutgoing > MAX_UINT64) invalid('outgoing requestId exhausted')
    validateOp(op)
    canonicalPayload(payload)
    const requestId = this.nextOutgoing.toString(10)
    this.nextOutgoing += 1n
    return { v: 1, op, requestId, payload, mac: computeMac(this.key, op, requestId, payload) }
  }

  verify(input: unknown): HelperCommandEnvelope {
    this.assertOpen()
    const envelope = parseEnvelope(input)
    const requestId = parseRequestId(envelope.requestId)
    const expected = Buffer.from(computeMac(this.key, envelope.op, envelope.requestId, envelope.payload), 'hex')
    const actual = Buffer.from(envelope.mac, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalid('command MAC mismatch')
    if (requestId <= this.lastIncoming) invalid('replayed or out-of-order requestId')
    this.lastIncoming = requestId
    return envelope
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.key.fill(0)
  }

  private assertOpen(): void {
    if (this.closed) invalid('helper MAC session is closed')
  }
}

export function computeMac(key: Buffer, op: HelperOp, requestId: string, payload: HelperPayload): string {
  if (key.length !== 32) invalid('session key must contain 32 bytes')
  validateOp(op)
  const id = parseRequestId(requestId)
  const idBytes = Buffer.allocUnsafe(8)
  idBytes.writeBigUInt64BE(id)
  const body = Buffer.concat([
    encodeField(Buffer.from('v=1', 'utf8')),
    encodeField(Buffer.from(op, 'utf8')),
    encodeField(idBytes),
    encodeField(Buffer.from(canonicalPayload(payload), 'utf8'))
  ])
  return createHmac('sha256', key).update(body).digest('hex')
}

export function canonicalPayload(payload: HelperPayload): string {
  const canonical = canonicalize(payload, new Set<object>())
  const encoded = JSON.stringify(canonical)
  if (Buffer.byteLength(encoded, 'utf8') > HELPER_MAX_PAYLOAD_BYTES) invalid('helper payload exceeds 4096 bytes')
  return encoded
}

function parseEnvelope(input: unknown): HelperCommandEnvelope {
  if (!isPlainObject(input)) invalid('command envelope must be a plain object')
  const keys = Object.keys(input).sort()
  if (keys.join(',') !== 'mac,op,payload,requestId,v') invalid('command envelope has missing or unknown fields')
  if (input.v !== 1 || typeof input.op !== 'string' || typeof input.requestId !== 'string' || typeof input.mac !== 'string') {
    invalid('command envelope field type mismatch')
  }
  validateOp(input.op)
  if (!MAC_HEX.test(input.mac)) invalid('command MAC must be canonical lowercase SHA-256 hex')
  parseRequestId(input.requestId)
  canonicalPayload(input.payload as HelperPayload)
  return input as unknown as HelperCommandEnvelope
}

function canonicalize(value: HelperPayload, seen: Set<object>): HelperPayload {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('payload contains a non-finite number')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') invalid('payload contains a non-JSON value')
  if (seen.has(value)) invalid('payload contains a cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => canonicalize(item, seen))
    if (!isPlainObject(value)) invalid('payload object must have a plain prototype')
    const result = Object.create(null) as Record<string, HelperPayload>
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) invalid('payload cannot contain accessors')
      result[key] = canonicalize(descriptor.value as HelperPayload, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function encodeField(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32LE(value.length)
  return Buffer.concat([length, value])
}

function parseRequestId(value: string): bigint {
  if (!REQUEST_ID.test(value)) invalid('requestId must be canonical uint64 decimal')
  const parsed = BigInt(value)
  if (parsed < 1n || parsed > MAX_UINT64) invalid('requestId is outside uint64 range')
  return parsed
}

function validateOp(value: string): asserts value is HelperOp {
  if (!(HELPER_OPS as readonly string[]).includes(value)) invalid('helper operation is not allowed')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(reason: string): never {
  throw new ProtocolError(
    ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID,
    'Privileged helper protocol rejected the command',
    { reason }
  )
}
