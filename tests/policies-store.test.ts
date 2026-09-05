import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePoliciesStore } from '../src/renderer/src/stores/policies'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'
import type {
  MihomoProxiesResponse,
  MihomoDelayResult
} from '../src/shared/mihomo-api'

const GROUP = '节点选择'
const PROXIES: MihomoProxiesResponse = {
  proxies: {
    [GROUP]: { name: GROUP, type: 'Selector', now: '香港 01', all: ['香港 01', '香港 02', 'DIRECT'] },
    '香港 01': { name: '香港 01', type: 'Shadowsocks', alive: true },
    '香港 02': { name: '香港 02', type: 'Shadowsocks', alive: false },
    DIRECT: { name: 'DIRECT', type: 'Direct' }
  }
}

function error(code: ProtocolErrorCode): ProtocolError {
  return new ProtocolError(code, 'boom')
}

describe('policies store', () => {
  let getProxies: ReturnType<typeof vi.fn>
  let getActiveGroupOrder: ReturnType<typeof vi.fn>
  let selectProxy: ReturnType<typeof vi.fn>
  let delayTest: ReturnType<typeof vi.fn>
  let groupMemberDelayTest: ReturnType<typeof vi.fn>
  let groupDelayTest: ReturnType<typeof vi.fn>
  let patchConfig: ReturnType<typeof vi.fn>
  let getConfig: ReturnType<typeof vi.fn>

  /**
   * Controller state the mocks read back, mirroring a real mihomo: the selection
   * PUT / GET /proxies and the mode PATCH / GET /configs round-trip through here,
   * so a later "confirmation read" reflects what the controller actually applied.
   */
  let controllerNow: string
  let controllerMode: string

  function proxiesResponse(now = controllerNow): MihomoProxiesResponse {
    return { ...PROXIES, proxies: { ...PROXIES.proxies, [GROUP]: { ...PROXIES.proxies[GROUP], now } } }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    controllerNow = '香港 01'
    controllerMode = 'rule'
    getProxies = vi.fn()
    getActiveGroupOrder = vi.fn().mockResolvedValue([])
    selectProxy = vi.fn()
    delayTest = vi.fn()
    groupMemberDelayTest = vi.fn()
    groupDelayTest = vi.fn()
    patchConfig = vi.fn()
    getConfig = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = {
      desktop: {
        mihomo: { getProxies, selectProxy, delayTest, groupMemberDelayTest, groupDelayTest, patchConfig, getConfig },
        profiles: { getActiveGroupOrder }
      }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as unknown as { window?: unknown }).window = undefined
  })

  it('loads groups and selects the first group and current member', async () => {
    getProxies.mockResolvedValue(PROXIES)
    const store = usePoliciesStore()
    await store.load()
    expect(store.status).toBe('ready')
    expect(store.groups.map((group) => group.name)).toEqual([GROUP])
    expect(store.selectedGroup).toBe(GROUP)
    expect(store.selectedMember).toBe('香港 01')
  })

  it('selects a node, confirms the controller applied it, and keeps it', async () => {
    getProxies.mockImplementation(async () => proxiesResponse(controllerNow))
    selectProxy.mockImplementation(async (_group, name) => {
      controllerNow = name
    })
    const store = usePoliciesStore()
    await store.load()
    await store.selectNode('香港 02')
    expect(store.selectedMember).toBe('香港 02')
    expect(selectProxy).toHaveBeenCalledWith(GROUP, '香港 02')
    expect(store.panelError).toBeNull()
  })

  it('surfaces a failed selection and reconciles to the controller state', async () => {
    getProxies.mockImplementation(async () => proxiesResponse(controllerNow))
    selectProxy.mockRejectedValue(error(ProtocolErrorCode.UPSTREAM_HTTP_ERROR))
    const store = usePoliciesStore()
    await store.load()
    // The controller never applied the write, so the confirmation read shows the
    // ORIGINAL member; the optimistic value is reconciled back and the error is
    // surfaced on the panel. selectNode itself no longer rejects.
    await store.selectNode('香港 02')
    expect(store.selectedMember).toBe('香港 01')
    expect(store.panelError).toBe('boom')
  })

  it('serializes rapid selections and confirms only the latest intent is applied', async () => {
    getProxies.mockImplementation(async () => proxiesResponse(controllerNow))
    const order: string[] = []
    const resolvers: Array<() => void> = []
    selectProxy.mockImplementation((_group, name) => new Promise<void>((resolve) => {
      order.push(name)
      resolvers.push(() => {
        controllerNow = name
        resolve()
      })
    }))
    const store = usePoliciesStore()
    await store.load()
    store.selectNode('香港 02')
    const second = store.selectNode('DIRECT')
    // DIRECT is held as the latest intent, so exactly one write is in flight.
    expect(order).toEqual(['香港 02'])
    expect(selectProxy).toHaveBeenCalledTimes(1)
    resolvers[0]()
    await Promise.resolve()
    // Once 香港 02 settles, the drain submits the coalesced DIRECT intent.
    expect(order).toEqual(['香港 02', 'DIRECT'])
    expect(selectProxy).toHaveBeenCalledTimes(2)
    resolvers[1]()
    await second
    expect(store.selectedMember).toBe('DIRECT')
    expect(store.panelError).toBeNull()
  })

  it('ignores a superseded selection failure and keeps the latest intent on success', async () => {
    getProxies.mockImplementation(async () => proxiesResponse(controllerNow))
    const store = usePoliciesStore()
    await store.load()
    const resolvers: Array<{ reject: (e: unknown) => void }> = []
    selectProxy.mockImplementationOnce((_group, _name) => new Promise<void>((_, reject) => resolvers.push({ reject })))
    selectProxy.mockImplementationOnce((_group, name) => new Promise<void>((resolve) => {
      controllerNow = name
      resolve()
    }))
    store.selectNode('香港 02')
    const second = store.selectNode('DIRECT')
    // The superseded 香港 02 write fails while DIRECT is the pending intent.
    resolvers[0].reject(error(ProtocolErrorCode.UPSTREAM_HTTP_ERROR))
    await Promise.resolve()
    await second
    expect(store.selectedMember).toBe('DIRECT')
    expect(store.panelError).toBeNull()
  })

  it('commits only the last of several rapid selections (coalesces intermediates)', async () => {
    getProxies.mockImplementation(async () => proxiesResponse(controllerNow))
    selectProxy.mockImplementation(async (_group, name) => {
      controllerNow = name
    })
    const store = usePoliciesStore()
    await store.load()
    await Promise.all([store.selectNode('香港 02'), store.selectNode('DIRECT'), store.selectNode('香港 01')])
    expect(store.selectedMember).toBe('香港 01')
    // DIRECT was coalesced away by the latest intent, so it is never written.
    expect(selectProxy).toHaveBeenCalledWith(GROUP, '香港 01')
    expect(selectProxy).toHaveBeenCalledWith(GROUP, '香港 02')
    expect(selectProxy).not.toHaveBeenCalledWith(GROUP, 'DIRECT')
    expect(store.panelError).toBeNull()
  })

  it('reports a recoverable error when the controller did not reach the requested member', async () => {
    getProxies.mockImplementation(async () => proxiesResponse(controllerNow))
    // The write "succeeds" server-side but the controller stubbornly keeps the
    // old member (e.g. the group dropped the request), so the confirmation read
    // disagrees with our intent.
    selectProxy.mockImplementation(async () => undefined)
    controllerNow = '香港 01'
    const store = usePoliciesStore()
    await store.load()
    await store.selectNode('香港 02')
    expect(store.selectedMember).toBe('香港 01')
    expect(store.panelError).toContain('香港 01')
  })

  it('records an ok delay from a node test', async () => {
    getProxies.mockResolvedValue(PROXIES)
    groupMemberDelayTest.mockResolvedValue({ delay: 42 } satisfies MihomoDelayResult)
    const store = usePoliciesStore()
    await store.load()
    await store.testNode('香港 01')
    expect(store.nodeState('香港 01')).toEqual({ status: 'ok', delay: 42 })
  })

  it('classifies a timeout as timeout and a probe failure as unavailable', async () => {
    getProxies.mockResolvedValue(PROXIES)
    const store = usePoliciesStore()
    await store.load()
    groupMemberDelayTest.mockRejectedValueOnce(error(ProtocolErrorCode.UPSTREAM_TIMEOUT))
    await store.testNode('香港 02')
    expect(store.nodeState('香港 02').status).toBe('timeout')
    groupMemberDelayTest.mockRejectedValueOnce(error(ProtocolErrorCode.UPSTREAM_TEST_FAILED))
    await store.testNode('香港 01')
    expect(store.nodeState('香港 01').status).toBe('unavailable')
  })

  it('classifies a generic HTTP error and a missing group as error, not unavailable', async () => {
    getProxies.mockResolvedValue(PROXIES)
    const store = usePoliciesStore()
    await store.load()
    groupMemberDelayTest.mockRejectedValueOnce(error(ProtocolErrorCode.UPSTREAM_HTTP_ERROR))
    await store.testNode('香港 01')
    expect(store.nodeState('香港 01').status).toBe('error')
    groupMemberDelayTest.mockRejectedValueOnce(error(ProtocolErrorCode.NOT_FOUND))
    await store.testNode('DIRECT')
    expect(store.nodeState('DIRECT').status).toBe('error')
  })

  it('applies per-node delays from testAll and labels a dead node timeout (no group endpoint)', async () => {
    getProxies.mockResolvedValue(PROXIES)
    // testAll fans out per-node probes (never /group/:name/delay — that endpoint
    // would clear a URLTest pin). Each member gets its own result or failure.
    groupMemberDelayTest.mockImplementation(async (_group: string, name: string) => {
      if (name === '香港 02') throw error(ProtocolErrorCode.UPSTREAM_TIMEOUT)
      return { delay: name === '香港 01' ? 42 : 6 } satisfies MihomoDelayResult
    })
    const store = usePoliciesStore()
    await store.load()
    await store.testAll()
    expect(store.groupDelayStatus).toBe('ok')
    expect(store.nodeState('香港 01')).toEqual({ status: 'ok', delay: 42 })
    expect(store.nodeState('DIRECT')).toEqual({ status: 'ok', delay: 6 })
    expect(store.nodeState('香港 02').status).toBe('timeout')
    expect(groupDelayTest).not.toHaveBeenCalled()
  })

  it('reports a group-level failure only when EVERY member probe fails', async () => {
    getProxies.mockResolvedValue(PROXIES)
    const store = usePoliciesStore()
    await store.load()
    groupMemberDelayTest.mockRejectedValue(error(ProtocolErrorCode.UPSTREAM_TIMEOUT))
    await store.testAll()
    expect(store.groupDelayStatus).toBe('error')
    expect(store.nodeState('香港 01').status).toBe('timeout')
    expect(store.nodeState('香港 02').status).toBe('timeout')
    // One healthy member is enough for the group sweep itself to count as ok —
    // individual dead nodes were already labeled per-node.
    groupMemberDelayTest.mockImplementation(async (_group: string, name: string) => {
      if (name === '香港 02') throw error(ProtocolErrorCode.UPSTREAM_TEST_FAILED)
      return { delay: 42 } satisfies MihomoDelayResult
    })
    await store.testAll()
    expect(store.groupDelayStatus).toBe('ok')
    expect(store.nodeState('香港 01')).toEqual({ status: 'ok', delay: 42 })
    expect(store.nodeState('香港 02').status).toBe('unavailable')
  })

  it('patches the mode, confirms the controller, and rolls back a rejected patch', async () => {
    getProxies.mockResolvedValue(PROXIES)
    getConfig.mockImplementation(async () => ({ mode: controllerMode }))
    patchConfig.mockImplementation(async (patch) => {
      controllerMode = (patch as { mode: string }).mode
    })
    const store = usePoliciesStore()
    await store.load()
    await store.setMode('global')
    expect(store.mode).toBe('global')
    expect(patchConfig).toHaveBeenCalledWith({ mode: 'global' })
    patchConfig.mockRejectedValueOnce(error(ProtocolErrorCode.UPSTREAM_HTTP_ERROR))
    await store.setMode('direct')
    // The rejected patch left the controller in 'global', so the confirmation
    // read reconciles mode back to it.
    expect(store.mode).toBe('global')
    expect(store.panelError).toBe('boom')
  })

  it('serializes rapid mode changes and confirms the latest mode', async () => {
    getProxies.mockResolvedValue(PROXIES)
    getConfig.mockImplementation(async () => ({ mode: controllerMode }))
    patchConfig.mockImplementation(async (patch) => {
      controllerMode = (patch as { mode: string }).mode
    })
    const store = usePoliciesStore()
    await store.load()
    await Promise.all([store.setMode('direct'), store.setMode('global')])
    expect(store.mode).toBe('global')
    expect(patchConfig).toHaveBeenCalledWith({ mode: 'global' })
    expect(store.panelError).toBeNull()
  })

  it('marks the store as error when loading proxies fails', async () => {
    getProxies.mockRejectedValue(error(ProtocolErrorCode.UPSTREAM_UNREACHABLE))
    const store = usePoliciesStore()
    await store.load()
    expect(store.status).toBe('error')
    expect(store.lastError).toBe('boom')
  })
})
