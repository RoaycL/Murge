import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUnlockStore } from '../src/renderer/src/stores/unlock'

describe('unlock store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('clears previous-node verdicts before a new probe, including on failure', async () => {
    const testAll = vi.fn()
      .mockResolvedValueOnce([{ name: 'Netflix', status: 'supported', region: 'US' }])
      .mockRejectedValueOnce(new Error('kernel unavailable'))
    ;(globalThis as unknown as { window: unknown }).window = {
      desktop: { unlock: { testAll, testOne: vi.fn() } }
    }
    const store = useUnlockStore()
    await store.testAll()
    expect(store.results.Netflix?.region).toBe('US')
    await store.testAll()
    expect(store.results).toEqual({})
    expect(store.error).toBe('kernel unavailable')
  })
})
