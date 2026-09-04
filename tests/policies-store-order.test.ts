import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePoliciesStore } from '../src/renderer/src/stores/policies'
import type { MihomoProxiesResponse } from '../src/shared/mihomo-api'

/**
 * The owner's contract: policy groups render in the ORIGINAL configuration-file
 * proxy-groups order, never alphabetically re-sorted.
 *
 * Neither controller endpoint can supply that order (verified against a real
 * kernel): `GET /proxies` is a Go map marshaled with SORTED keys, and
 * `GET /group` iterates the same map — Go range order, randomized per request.
 * The order therefore comes from the ACTIVE PROFILE DOCUMENT parsed in main
 * (`profiles.getActiveGroupOrder`). The fixture reproduces the real wire
 * behavior: the /proxies map arrives alphabetically ordered while the profile
 * order is the config order, and the store must present the latter.
 */
const WIRE_PROXIES: MihomoProxiesResponse = {
  proxies: {
    DIRECT: { name: 'DIRECT', type: 'Direct' },
    GLOBAL: { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
    中间组: { name: '中间组', type: 'Fallback', now: 'n3', all: ['n3'] },
    最后组: { name: '最后组', type: 'Selector', now: 'n1', all: ['n1'], icon: 'https://example.com/z.png' },
    首个组: { name: '首个组', type: 'URLTest', now: 'n2', all: ['n2'], icon: 'https://example.com/a.png' }
  }
}

const CONFIG_ORDER = ['最后组', 'GLOBAL', '首个组', '中间组']

function installWindow(response: MihomoProxiesResponse, ordered: string[]): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    desktop: {
      mihomo: {
        getProxies: vi.fn().mockResolvedValue(response)
      },
      profiles: {
        getActiveGroupOrder: vi.fn().mockResolvedValue(ordered)
      }
    }
  }
}

describe('policies store group ordering & icons', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow(WIRE_PROXIES, CONFIG_ORDER)
  })

  it('keeps groups in the active profile configuration order', async () => {
    const store = usePoliciesStore()
    await store.load()
    expect(store.groups.map((group) => group.name)).toEqual(['最后组', 'GLOBAL', '首个组', '中间组'])
    // The /proxies map order alone would have produced GLOBAL/中间组/最后组/首个组.
    expect(store.groups[0].name).not.toBe('GLOBAL')
  })

  it('prefers a group from the ordered list as the initial selection', async () => {
    const store = usePoliciesStore()
    await store.load()
    expect(store.selectedGroup).toBe('最后组')
    expect(store.selectedMember).toBe('n1')
  })

  it('falls back to the /proxies map order when the profile order is unavailable', async () => {
    // Degraded mode: still functional, just the (alphabetical) map order.
    installWindow(WIRE_PROXIES, [])
    const store = usePoliciesStore()
    await store.load()
    // Degraded mode: still functional, just the (alphabetical) map order.
    const names = store.groups.map((group) => group.name)
    expect(names).toEqual(['GLOBAL', '中间组', '最后组', '首个组'])
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
