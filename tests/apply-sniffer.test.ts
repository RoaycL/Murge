import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { applySnifferEnhancementToDocument } from '../src/main/kernel/sniffer/apply-sniffer'
import { EMPTY_SNIFFER_ENHANCEMENT } from '@shared/sniffer'

const BASE = `
port: 7890
mode: rule
sniffer:
  enable: false
  port-black-list:
    - 23
`

describe('applySnifferEnhancementToDocument', () => {
  it('merges the generated sniffer block and preserves unknown sniffer keys', () => {
    const result = applySnifferEnhancementToDocument(BASE, { ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true })
    expect(result.warnings).toEqual([])
    const doc = parse(result.text) as Record<string, unknown>
    const sniffer = doc.sniffer as Record<string, unknown>
    expect(sniffer.enable).toBe(true)
    expect(sniffer['override-destination']).toBe(true)
    expect(sniffer.sniff).toEqual({ HTTP: { ports: ['80', '8080-8880'] }, TLS: { ports: ['443', '8443'] }, QUIC: { ports: ['443'] } })
    // Profile key the model does not own is preserved.
    expect(sniffer['port-black-list']).toEqual([23])
    expect(doc.port).toBe(7890)
    expect(doc.mode).toBe('rule')
  })

  it('returns the base document unchanged when disabled', () => {
    const result = applySnifferEnhancementToDocument(BASE, { ...EMPTY_SNIFFER_ENHANCEMENT, enabled: false })
    expect(result.text).toBe(BASE)
    expect(result.warnings).toEqual([])
  })

  it('does not write an empty block after clearing a list', () => {
    const result = applySnifferEnhancementToDocument(BASE, {
      ...EMPTY_SNIFFER_ENHANCEMENT,
      enabled: true,
      skipDomain: [],
      forceDomain: [],
      skipSrcAddress: [],
      skipDstAddress: []
    })
    const sniffer = (parse(result.text) as Record<string, unknown>).sniffer as Record<string, unknown>
    expect(sniffer['skip-domain']).toBeUndefined()
    expect(sniffer['force-domain']).toBeUndefined()
    expect(sniffer['skip-src-address']).toBeUndefined()
    expect(sniffer['skip-dst-address']).toBeUndefined()
    expect(sniffer.enable).toBe(true)
  })

  it('warns and returns the base on an unparseable document', () => {
    const result = applySnifferEnhancementToDocument('[:not: yaml', { ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true })
    expect(result.text).toBe('[:not: yaml')
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
