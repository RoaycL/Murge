import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { useSnifferEnhancementStore } from '../src/renderer/src/stores/sniffer-enhancement'
import { EMPTY_SNIFFER_ENHANCEMENT } from '../src/shared/sniffer'

const snifferSet = vi.fn()
const snifferPreview = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = {
    desktop: {
      sniffer: { get: vi.fn(), set: snifferSet, preview: snifferPreview }
    }
  }
})
afterEach(() => { ;(globalThis as unknown as { window?: unknown }).window = undefined })

/** Electron's structured clone rejects reactivity Proxies, exactly like the real IPC boundary. */
function cloneOrThrow<T>(value: T): T {
  return structuredClone(value)
}

describe('Sniffer enhancement store IPC payload', () => {
  it('marks the model hydrated only after a successful persisted read', async () => {
    const get = vi.mocked(window.desktop.sniffer.get)
    get.mockRejectedValueOnce(new Error('read failed'))
    const store = useSnifferEnhancementStore()
    await store.refresh()
    expect(store.hydrated).toBe(false)
    get.mockResolvedValueOnce({ enhancement: EMPTY_SNIFFER_ENHANCEMENT })
    await store.refresh()
    expect(store.hydrated).toBe(true)
  })

  it('sends a plain model when saving a reactive spread like the overview quick toggle builds', async () => {
    snifferSet.mockImplementation((input: unknown) => Promise.resolve({ enhancement: cloneOrThrow(input) }))
    const store = useSnifferEnhancementStore()
    const reactiveModel = reactive({ ...EMPTY_SNIFFER_ENHANCEMENT })
    const input = { ...reactiveModel, enabled: true }
    // The regression: a shallow spread of the reactive store model keeps Proxy
    // nested values (ports / domain lists) and used to fail with
    // "An object could not be cloned".
    expect(() => structuredClone(input)).toThrow()
    const ok = await store.save(input)
    expect(ok).toBe(true)
    expect(store.lastError).toBeNull()
    // The store persisted what the main side echoed back (the mock echoes the input).
    expect(store.enhancement.enabled).toBe(true)
    expect(snifferSet).toHaveBeenCalledOnce()
  })

  it('sends a plain model to preview as well', async () => {
    snifferPreview.mockImplementation((input: unknown) => { cloneOrThrow(input); return Promise.resolve('sniffer: yaml') })
    const store = useSnifferEnhancementStore()
    const reactiveModel = reactive({ ...EMPTY_SNIFFER_ENHANCEMENT })
    const yaml = await store.preview({ ...reactiveModel })
    expect(yaml).toBe('sniffer: yaml')
    expect(store.lastError).toBeNull()
  })
})
