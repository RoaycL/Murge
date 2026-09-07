import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { useGeodataSettingsStore } from '../src/renderer/src/stores/geodata-settings'
import { EMPTY_GEODATA_SETTINGS } from '../src/shared/geodata'

const geodataSet = vi.fn()
const geodataPreview = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = {
    desktop: {
      geodata: { get: vi.fn(), set: geodataSet, preview: geodataPreview }
    }
  }
})

afterEach(() => { ;(globalThis as unknown as { window?: unknown }).window = undefined })

describe('geodata settings store IPC payload', () => {
  it('removes nested Vue proxies before saving', async () => {
    geodataSet.mockImplementation((input: unknown) => Promise.resolve(structuredClone(input)))
    const store = useGeodataSettingsStore()
    const reactiveModel = reactive({
      ...EMPTY_GEODATA_SETTINGS,
      geoxUrls: { ...EMPTY_GEODATA_SETTINGS.geoxUrls }
    })
    const input = { ...reactiveModel, enabled: true }

    expect(() => structuredClone(input)).toThrow()
    expect(await store.save(input)).toBe(true)
    expect(store.settings.enabled).toBe(true)
    expect(store.lastError).toBeNull()
  })

  it('removes nested Vue proxies before previewing', async () => {
    geodataPreview.mockImplementation((input: unknown) => {
      structuredClone(input)
      return Promise.resolve('geo: yaml')
    })
    const store = useGeodataSettingsStore()
    const reactiveModel = reactive({
      ...EMPTY_GEODATA_SETTINGS,
      geoxUrls: { ...EMPTY_GEODATA_SETTINGS.geoxUrls }
    })

    expect(await store.preview({ ...reactiveModel })).toBe('geo: yaml')
    expect(store.lastError).toBeNull()
  })
})
