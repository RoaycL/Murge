import { describe, it, expect } from 'vitest'
import { parseImportRequest, parseConfigEdit, parseProfileName, parseProfilePatch } from '../src/shared/schemas/profiles'
import { ProtocolError } from '../src/shared/protocol-errors'

const VALID_REQUEST = {
  name: 'my profile',
  document: 'proxies: []\n',
  source: { type: 'manual' }
}

describe('parseImportRequest', () => {
  it('accepts a valid manual import request', () => {
    expect(parseImportRequest(VALID_REQUEST)).toEqual({
      name: 'my profile',
      document: 'proxies: []\n',
      source: { type: 'manual' },
      activate: false
    })
  })

  it('rejects an empty name', () => {
    expect(() => parseImportRequest({ ...VALID_REQUEST, name: '  ' })).toThrow(/non-empty/i)
  })

  it('rejects unknown keys so credentials cannot be smuggled in', () => {
    expect(() => parseImportRequest({ ...VALID_REQUEST, token: 'supersecret' })).toThrow(/invalid import request/i)
  })

  it('rejects a non-object payload', () => {
    expect(() => parseImportRequest('nope')).toThrow(/must be an object/i)
  })
})

describe('parseConfigEdit', () => {
  it('accepts a supported edit', () => {
    expect(parseConfigEdit({ key: 'mixed-port', value: '8888' })).toEqual({ key: 'mixed-port', value: '8888' })
  })

  it('rejects a missing key or an unknown field', () => {
    expect(() => parseConfigEdit({ value: '8888' })).toThrow(/invalid config edit/i)
    expect(() => parseConfigEdit({ key: 'mode', value: 'rule', extra: true })).toThrow(/invalid config edit/i)
  })
})

describe('parseProfileName', () => {
  it('accepts a non-empty name or id', () => {
    expect(parseProfileName('abc')).toBe('abc')
  })

  it('rejects an empty name or id', () => {
    expect(() => parseProfileName('')).toThrow(/non-empty/i)
    expect(() => parseProfileName(undefined)).toThrow(/non-empty/i)
  })
})

describe('parseProfilePatch', () => {
  it('accepts a name-only or source-only patch', () => {
    expect(parseProfilePatch({ name: 'new' })).toEqual({ name: 'new' })
    expect(parseProfilePatch({ source: { type: 'url', url: 'https://x' } }).source?.type).toBe('url')
  })

  it('rejects a patch with unknown fields', () => {
    expect(() => parseProfilePatch({ name: 'new', secret: 'x' })).toThrow(/invalid profile patch/i)
  })
})

/**
 * Regression coverage for config-edit key/value injection. Restricting the key to
 * the same allowlist `parseConfigPatch` uses is what prevents a renderer from
 * writing `tun`, or a key containing `:` that would emit invalid YAML.
 */
describe('parseConfigEdit key allowlist', () => {
  it('rejects tun, which must never be written from the renderer', () => {
    expect(() => parseConfigEdit({ key: 'tun', value: '{enable: true}' })).toThrowError(ProtocolError)
  })

  it('rejects an arbitrary unknown key', () => {
    expect(() => parseConfigEdit({ key: 'anything-goes', value: 'x' })).toThrowError(ProtocolError)
  })

  it('rejects a key containing a colon that would emit invalid YAML', () => {
    // `x: y` previously produced the line `x: y: z`, which is not valid YAML and
    // which the structural validator could not detect.
    expect(() => parseConfigEdit({ key: 'x: y', value: 'z' })).toThrowError(ProtocolError)
  })

  it('accepts every supported key', () => {
    expect(parseConfigEdit({ key: 'mode', value: 'global' })).toEqual({ key: 'mode', value: 'global' })
    expect(parseConfigEdit({ key: 'mixed-port', value: '7890' })).toEqual({ key: 'mixed-port', value: '7890' })
    expect(parseConfigEdit({ key: 'allow-lan', value: 'false' })).toEqual({ key: 'allow-lan', value: 'false' })
    expect(parseConfigEdit({ key: 'log-level', value: 'debug' })).toEqual({ key: 'log-level', value: 'debug' })
  })

  it('enforces the per-key value type', () => {
    expect(() => parseConfigEdit({ key: 'mode', value: 'nonsense' })).toThrowError(ProtocolError)
    expect(() => parseConfigEdit({ key: 'mixed-port', value: '70000' })).toThrowError(ProtocolError)
    expect(() => parseConfigEdit({ key: 'mixed-port', value: 'abc' })).toThrowError(ProtocolError)
    expect(() => parseConfigEdit({ key: 'allow-lan', value: 'yes' })).toThrowError(ProtocolError)
    expect(() => parseConfigEdit({ key: 'log-level', value: 'verbose' })).toThrowError(ProtocolError)
  })
})
