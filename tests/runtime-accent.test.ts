import { describe, expect, it } from 'vitest'
import { resolveRuntimeAccent } from '../src/shared/runtime-accent'

describe('resolveRuntimeAccent', () => {
  it('uses neutral grey when neither takeover mode is verified active', () => {
    expect(resolveRuntimeAccent('disabled', 'configured')).toBe('idle')
    expect(resolveRuntimeAccent('enabling', 'starting')).toBe('idle')
  })

  it('uses green for system proxy and blue for active TUN with TUN priority', () => {
    expect(resolveRuntimeAccent('enabled', 'configured')).toBe('proxy')
    expect(resolveRuntimeAccent('disabled', 'active')).toBe('tun')
    expect(resolveRuntimeAccent('enabled', 'active')).toBe('tun')
  })
})
