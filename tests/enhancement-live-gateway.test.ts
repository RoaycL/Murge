import { describe, expect, it, vi } from 'vitest'
import {
  EnhancementApplyCoordinator,
  LiveDnsEnhancementGateway,
  LiveSnifferEnhancementGateway
} from '../src/main/kernel/enhancement-live-gateway'
import { EMPTY_DNS_ENHANCEMENT } from '../src/shared/dns'
import { EMPTY_SNIFFER_ENHANCEMENT } from '../src/shared/sniffer'

describe('live enhancement gateways', () => {
  it('persists then applies DNS inside the shared transition boundary', async () => {
    let enhancement = { ...EMPTY_DNS_ENHANCEMENT }
    const inner = {
      get: vi.fn(async () => ({ enhancement: { ...enhancement } })),
      set: vi.fn(async (input: typeof enhancement) => ({ enhancement: (enhancement = { ...input }) })),
      preview: vi.fn(() => '')
    }
    const events: string[] = []
    const coordinator = new EnhancementApplyCoordinator(
      async (operation) => { events.push('lock'); const result = await operation(); events.push('unlock'); return result },
      async () => { events.push('apply') }
    )
    const gateway = new LiveDnsEnhancementGateway(inner, coordinator)

    await gateway.set({ ...enhancement, enabled: true })

    expect(enhancement.enabled).toBe(true)
    expect(events).toEqual(['lock', 'apply', 'unlock'])
  })

  it('restores persisted sniffer state and reapplies it when live reload fails', async () => {
    let enhancement = { ...EMPTY_SNIFFER_ENHANCEMENT }
    const inner = {
      get: vi.fn(async () => ({ enhancement: { ...enhancement } })),
      set: vi.fn(async (input: typeof enhancement) => ({ enhancement: (enhancement = { ...input }) })),
      preview: vi.fn(() => '')
    }
    const apply = vi.fn()
      .mockRejectedValueOnce(new Error('candidate rejected'))
      .mockResolvedValueOnce(undefined)
    const coordinator = new EnhancementApplyCoordinator(async (operation) => operation(), apply)
    const gateway = new LiveSnifferEnhancementGateway(inner, coordinator)

    await expect(gateway.set({ ...enhancement, enabled: true })).rejects.toThrow('candidate rejected')

    expect(enhancement.enabled).toBe(false)
    expect(inner.set).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(2)
  })
})
