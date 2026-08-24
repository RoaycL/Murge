import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brand } from '@shared/brand'
import { BRAND_PATTERN_FIELDS } from '@shared/brand-patterns'
import { parseBrandConfig } from '@shared/schemas/brand'
import { ProtocolError } from '@shared/protocol-errors'

const schema = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'schemas', 'brand.schema.json'), 'utf8'))

describe('brand JSON Schema <-> runtime sync', () => {
  it('declares $schema as an allowed property', () => {
    expect(schema.properties).toHaveProperty('$schema')
    expect(schema.additionalProperties).toBe(false)
  })

  it('mirrors the canonical patterns exactly', () => {
    for (const [field, pattern] of Object.entries(BRAND_PATTERN_FIELDS)) {
      expect(schema.properties[field].pattern).toBe(pattern)
    }
  })

  it('requires the same fields the runtime schema requires', () => {
    expect(schema.required).toEqual(
      expect.arrayContaining(['productName', 'shortName', 'appId', 'executableName', 'protocolScheme'])
    )
  })

  it('accepts the real brand config', () => {
    expect(parseBrandConfig(brand).productName).toBe(brand.productName)
  })

  it('rejects the same malformed values through both JSON Schema and Zod', () => {
    const badValues: Array<[string, string]> = [
      ['appId', '1io.client.desktop'], // JSON Schema requires a letter start
      ['executableName', 'client.app'], // JSON Schema forbids a dot in the executable name
      ['protocolScheme', 'Mixed'] // JSON Schema requires a lowercase scheme start
    ]
    for (const [field, value] of badValues) {
      // JSON Schema pattern must reject it.
      const pattern = schema.properties[field].pattern
      expect(value).not.toMatch(new RegExp(pattern))
      // Zod must say the same thing.
      expect(() => parseBrandConfig({ ...brand, [field]: value })).toThrowError(ProtocolError)
    }
  })

  it('rejects a whitespace-only productName through both surfaces', () => {
    // JSON Schema pattern (\\S) and Zod trim().min(1) must agree.
    expect('   ').not.toMatch(new RegExp(schema.properties.productName.pattern))
    expect(() => parseBrandConfig({ ...brand, productName: '   ' })).toThrowError(ProtocolError)
  })

  it('rejects an unknown brand key through both surfaces', () => {
    expect(schema.additionalProperties).toBe(false)
    expect(() => parseBrandConfig({ ...brand, unexpected: 'nope' })).toThrowError(ProtocolError)
  })
})
