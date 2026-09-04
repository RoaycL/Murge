import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePoliciesStore } from '../src/renderer/src/stores/policies'
import type { MihomoProxiesResponse } from '../src/shared/mihomo-api'

/**
 * The owner's contract: policy groups render in the ORIGINAL configuration-file
 * order (as serialized by mihomo), never alphabetically re-sorted. These names
 * are deliberately NOT in alphabetical order so a localeCompare/sort anywhere in
 * the pipeline would flip them and fail the assertion.
 */
const CONFIG_ORDER_RESPONSE: MihomoProxiesResponse = {
  proxies: {
    DIRECT: { name: 'DIRECT', type: 'Direct' },
    最后组: { name: '最后组', type: 'Selector', now: 'n1', all: ['n1'], icon: 'https://example.com/z.png' },
    GLOBAL: { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
    首个组: { name: '首个组', type: 'URLTest', now: 'n2', all: ['n2'], icon: 'https://example.com/a.png' },
    中间组: { name: '中间组', type: 'Fallback', now: 'n3', all: ['n3'] }
  }
}

function installWindow(response: MihomoProxiesResponse): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    desktop: {
      mihomo: {
        getProxies: vi.fn().mockResolvedValue(response)
      }
    }
  }
}

describe('policies store group ordering & icons', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow(CONFIG_ORDER_RESPONSE)
  })

  it('keeps groups in configuration order, not alphabetical order', async () => {
    const store = usePoliciesStore()
    await store.load()
    expect(store.groups.map((group) => group.name)).toEqual(['最后组', 'GLOBAL', '首个组', '中间组'])
    // A sort would have produced GLOBAL/中间组/最后组/首个组 — prove it did not happen.
    expect(store.groups[0].name).not.toBe('GLOBAL')
  })

  it('surfaces the group icon from the config for the UI to render', async () => {
    const store = usePoliciesStore()
    await store.load()
    const withIcon = store.groups.filter((group) => group.icon)
    expect(withIcon).toHaveLength(2)
    expect(withIcon[0].icon).toBe('https://example.com/z.png')
  })

  it('filters non-group entries out of the group list', async () => {
    const store = usePoliciesStore()
    await store.load()
    expect(store.groups.some((group) => group.name === 'DIRECT')).toBe(false)
  })
})
