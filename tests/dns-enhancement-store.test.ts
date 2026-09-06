import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { useDnsEnhancementStore } from '../src/renderer/src/stores/dns-enhancement'
import { EMPTY_DNS_ENHANCEMENT } from '../src/shared/dns'

const dnsSet = vi.fn()
const dnsPreview = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = {
    desktop: {
      dns: { get: vi.fn(), set: dnsSet, preview: dnsPreview }
    }
  }
})
afterEach(() => { ;(globalThis as unknown as { window?: unknown }).window = undefined })

/** Electron's structured clone rejects reactivity Proxies, exactly like the real IPC boundary. */
function cloneOrThrow<T>(value: T): T {
  return structuredClone(value)
}

describe('DNS enhancement store IPC payload', () => {
  it('sends a plain model when saving a reactive spread like the overview quick toggle builds', async () => {
    dnsSet.mockImplementation((input: unknown) => Promise.resolve({ enhancement: cloneOrThrow(input) }))
    const store = useDnsEnhancementStore()
    const reactiveModel = reactive({ ...EMPTY_DNS_ENHANCEMENT })
    const input = { ...reactiveModel, enabled: false }
    // The regression: a shallow spread of the reactive store model keeps Proxy
    // nested values and used to fail with "An object could not be cloned".
    expect(() => structuredClone(input)).toThrow()
    const ok = await store.save(input)
    expect(ok).toBe(true)
    expect(store.lastError).toBeNull()
    expect(store.enhancement).toEqual(EMPTY_DNS_ENHANCEMENT)
  })

  it('sends a plain model to preview as well', async () => {
    dnsPreview.mockImplementation((input: unknown) => { cloneOrThrow(input); return Promise.resolve('dns: yaml') })
    const store = useDnsEnhancementStore()
    const reactiveModel = reactive({ ...EMPTY_DNS_ENHANCEMENT })
    const yaml = await store.preview({ ...reactiveModel })
    expect(yaml).toBe('dns: yaml')
    expect(store.lastError).toBeNull()
  })

  it('reports the IPC failure and leaves the model untouched when the main side rejects', async () => {
    dnsSet.mockRejectedValue(new Error('An object could not be cloned'))
    const store = useDnsEnhancementStore()
    const ok = await store.save({ ...EMPTY_DNS_ENHANCEMENT })
    expect(ok).toBe(false)
    expect(store.lastError).toBe('An object could not be cloned')
  })
})
