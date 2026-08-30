import { describe, expect, it } from 'vitest'
import {
  HELPER_MAX_PAYLOAD_BYTES,
  HELPER_OPS,
  HelperMacSession,
  canonicalPayload,
  computeMac,
  deriveHelperSessionKey
} from '../src/main/tun/helper-protocol'
import { ProtocolErrorCode } from '../src/shared/protocol-errors'

const KEY = Buffer.alloc(32, 0x2a)

describe('privileged helper canonical protocol', () => {
  it('canonicalizes nested object keys without changing array order', () => {
    expect(canonicalPayload({ z: 1, a: { y: true, x: ['b', 'a'] } })).toBe('{"a":{"x":["b","a"],"y":true},"z":1}')
  })

  it('preserves __proto__ as data and rejects accessor side effects', () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"safe":1}')
    expect(canonicalPayload(parsed)).toBe('{"__proto__":{"admin":true},"safe":1}')
    const accessor = Object.create(null, { value: { enumerable: true, get: () => 'secret' } })
    expect(() => canonicalPayload(accessor)).toThrowError(
      expect.objectContaining({ code: ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID })
    )
  })

  it('produces the same MAC for semantically identical key order', () => {
    const first = computeMac(KEY, 'health', '1', { b: 2, a: 1 })
    const second = computeMac(KEY, 'health', '1', { a: 1, b: 2 })
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses distinct MACs for field-boundary and request changes', () => {
    const base = computeMac(KEY, 'get_status', '1', { value: 'a|b' })
    expect(computeMac(KEY, 'get_status', '2', { value: 'a|b' })).not.toBe(base)
    expect(computeMac(KEY, 'health', '1', { value: 'a|b' })).not.toBe(base)
    expect(computeMac(KEY, 'get_status', '1', { value: 'a', extra: 'b' })).not.toBe(base)
  })

  it('creates monotonic canonical uint64 request IDs', () => {
    const session = new HelperMacSession(KEY)
    expect(session.create('health', null).requestId).toBe('1')
    expect(session.create('get_status', {}).requestId).toBe('2')
  })

  it('verifies a peer command once and rejects replay or out-of-order IDs', () => {
    const sender = new HelperMacSession(KEY)
    const receiver = new HelperMacSession(KEY)
    const first = sender.create('health', { ok: true })
    const second = sender.create('get_status', null)
    expect(receiver.verify(first)).toEqual(first)
    expect(() => receiver.verify(first)).toThrowError(expect.objectContaining({ code: ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID }))
    expect(receiver.verify(second)).toEqual(second)
  })

  it('checks MAC before advancing the replay cursor', () => {
    const sender = new HelperMacSession(KEY)
    const receiver = new HelperMacSession(KEY)
    const valid = sender.create('health', null)
    expect(() => receiver.verify({ ...valid, mac: '0'.repeat(64) })).toThrow()
    expect(receiver.verify(valid)).toEqual(valid)
  })

  it.each([
    ['unknown operation', { v: 1, op: 'shell', requestId: '1', mac: '0'.repeat(64), payload: null }],
    ['leading-zero id', { v: 1, op: 'health', requestId: '01', mac: '0'.repeat(64), payload: null }],
    ['zero id', { v: 1, op: 'health', requestId: '0', mac: '0'.repeat(64), payload: null }],
    ['overflow id', { v: 1, op: 'health', requestId: '18446744073709551616', mac: '0'.repeat(64), payload: null }],
    ['uppercase MAC', { v: 1, op: 'health', requestId: '1', mac: 'A'.repeat(64), payload: null }],
    ['extra field', { v: 1, op: 'health', requestId: '1', mac: '0'.repeat(64), payload: null, command: 'whoami' }]
  ])('rejects %s', (_name, value) => {
    expect(() => new HelperMacSession(KEY).verify(value)).toThrowError(
      expect.objectContaining({ code: ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID })
    )
  })

  it('rejects oversized, cyclic and non-finite payloads', () => {
    expect(() => canonicalPayload('x'.repeat(HELPER_MAX_PAYLOAD_BYTES + 1))).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalPayload(cyclic as never)).toThrow()
    expect(() => canonicalPayload({ value: Number.NaN })).toThrow()
  })

  it('keeps the helper operation surface fixed', () => {
    expect(HELPER_OPS).toEqual([
      'probe_integrity', 'create_adapter', 'apply_network_state', 'close_creator_handle',
      'snapshot', 'restore', 'get_status', 'health'
    ])
  })

  it('derives role-separated session keys and zeroizes the launch secret', () => {
    const firstSecret = Buffer.alloc(32, 7)
    const secondSecret = Buffer.alloc(32, 7)
    const salt = Buffer.alloc(16, 9)
    const app = deriveHelperSessionKey(firstSecret, salt, 'app-client')
    const helper = deriveHelperSessionKey(secondSecret, salt, 'privileged-helper')
    expect(app).not.toEqual(helper)
    expect(firstSecret.equals(Buffer.alloc(32))).toBe(true)
    expect(secondSecret.equals(Buffer.alloc(32))).toBe(true)
  })

  it('zeroizes malformed launch material on the error path', () => {
    const malformed = Buffer.alloc(8, 7)
    expect(() => deriveHelperSessionKey(malformed, Buffer.alloc(16), 'app-client')).toThrow()
    expect(malformed.equals(Buffer.alloc(8))).toBe(true)
  })

  it('zeroizes and permanently closes a session idempotently', () => {
    const session = new HelperMacSession(KEY)
    session.close()
    session.close()
    expect(() => session.create('health', null)).toThrowError(
      expect.objectContaining({ code: ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID })
    )
  })
})
