import { describe, it, expect } from 'vitest'
import { brand } from '@shared/brand'
import { APP_ID_PATTERN } from '@shared/brand-patterns'
import { parseBrandConfig } from '@shared/schemas/brand'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

describe('parseBrandConfig', () => {
  it('accepts the real brand configuration file', () => {
    const parsed = parseBrandConfig(brand)
    expect(parsed.productName).toBe(brand.productName)
    expect(parsed.appId).toMatch(new RegExp(APP_ID_PATTERN))
  })

  it('preserves extra keys such as $schema', () => {
    const input = { ...brand, $schema: 'https://example.com/brand.schema.json' }
    const parsed = parseBrandConfig(input)
    expect(parsed.productName).toBe(brand.productName)
  })

  it('throws a typed INVALID_BRAND error on a missing key', () => {
    const input = { ...brand } as Record<string, unknown>
    delete input.productName
    expect(() => parseBrandConfig(input)).toThrowError(ProtocolError)
    try {
      parseBrandConfig(input)
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.INVALID_BRAND)
    }
  })

  it('throws a typed INVALID_BRAND error on an invalid appId', () => {
    const input = { ...brand, appId: 'has spaces' }
    expect(() => parseBrandConfig(input)).toThrowError(ProtocolError)
  })

  it('throws a typed INVALID_BRAND error on a wrong type', () => {
    const input = { ...brand, shortName: 42 }
    expect(() => parseBrandConfig(input)).toThrowError(ProtocolError)
  })
})
