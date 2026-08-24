import { describe, it, expect } from 'vitest'
import {
  ProtocolError,
  ProtocolErrorCode,
  encodeProtocolError,
  decodeProtocolError,
  toProtocolError
} from '@shared/protocol-errors'

describe('ProtocolError', () => {
  it('carries a code and is an Error', () => {
    const error = new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'bad input')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.message).toBe('bad input')
  })

  it('round-trips a code through the IPC message encoding', () => {
    const original = new ProtocolError(ProtocolErrorCode.INVALID_UPSTREAM, 'missing field: proxy')
    const encoded = encodeProtocolError(original)
    expect(encoded).toMatch(/^PROTOCOL_ERROR:INVALID_UPSTREAM::/)

    const decoded = decodeProtocolError(encoded)
    expect(decoded).not.toBeNull()
    expect(decoded?.code).toBe(ProtocolErrorCode.INVALID_UPSTREAM)
    expect(decoded?.message).toBe('missing field: proxy')
  })

  it('decodes even when Electron prepends the channel to the message', () => {
    const encoded = encodeProtocolError(new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'nope'))
    const wrapped = `Error invoking remote method 'mihomo:patch-config': ${encoded}`
    const decoded = decodeProtocolError(wrapped)
    expect(decoded?.code).toBe(ProtocolErrorCode.INVALID_ARGUMENT)
    expect(decoded?.message).toBe('nope')
  })

  it('propagates messages that contain the separator without truncation', () => {
    const original = new ProtocolError(ProtocolErrorCode.INTERNAL, 'code::still part of message')
    const decoded = decodeProtocolError(encodeProtocolError(original))
    expect(decoded?.message).toBe('code::still part of message')
  })

  it('returns null for a message not produced by the encoder', () => {
    expect(decodeProtocolError('some random error')).toBeNull()
    expect(decodeProtocolError('')).toBeNull()
  })

  it('coerces unknown caught values to an INTERNAL ProtocolError', () => {
    expect(toProtocolError('boom').code).toBe(ProtocolErrorCode.INTERNAL)
    expect(toProtocolError(new Error('kaboom')).code).toBe(ProtocolErrorCode.INTERNAL)
    const known = new ProtocolError(ProtocolErrorCode.NOT_FOUND, 'x')
    expect(toProtocolError(known)).toBe(known)
  })
})
