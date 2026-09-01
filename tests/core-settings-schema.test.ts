import { describe, expect, it } from 'vitest'
import { parseCoreSettings } from '../src/shared/schemas/ipc'
import { ProtocolError } from '../src/shared/protocol-errors'

const valid = {
  enabled: true,
  logLevel: 'warning',
  ipv6: true,
  tcpConcurrent: false,
  unifiedDelay: true,
  findProcessMode: 'strict'
}

describe('core-settings schema', () => {
  it('accepts a complete valid model', () => {
    expect(parseCoreSettings(valid)).toEqual(valid)
  })

  it('rejects an unknown key (strict)', () => {
    expect(() => parseCoreSettings({ ...valid, extra: 1 })).toThrowError(ProtocolError)
  })

  it('rejects an invalid log level', () => {
    expect(() => parseCoreSettings({ ...valid, logLevel: 'loud' })).toThrowError(ProtocolError)
  })

  it('rejects an invalid find-process-mode', () => {
    expect(() => parseCoreSettings({ ...valid, findProcessMode: 'always2' })).toThrowError(ProtocolError)
  })

  it('rejects a non-object', () => {
    expect(() => parseCoreSettings('nope')).toThrowError(ProtocolError)
    expect(() => parseCoreSettings([])).toThrowError(ProtocolError)
  })
})
