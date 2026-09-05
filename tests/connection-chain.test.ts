import { describe, expect, it } from 'vitest'
import { connectionChainHops, formatConnectionChain } from '../src/shared/connection-chain'

describe('mihomo connection chain presentation', () => {
  it('reverses the exit-first API order for user-facing routing order', () => {
    const raw = ['[Oracle] xtls-reality', 'Oracle', 'Telegram']
    expect(connectionChainHops(raw)).toEqual(['Telegram', 'Oracle', '[Oracle] xtls-reality'])
    expect(formatConnectionChain(raw)).toBe('Telegram → Oracle → [Oracle] xtls-reality')
    expect(raw).toEqual(['[Oracle] xtls-reality', 'Oracle', 'Telegram'])
  })

  it('keeps direct routes readable and defaults missing chains to DIRECT', () => {
    expect(formatConnectionChain(['DIRECT'])).toBe('DIRECT')
    expect(formatConnectionChain([])).toBe('DIRECT')
  })
})
