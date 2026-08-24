import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePoliciesStore } from '../src/renderer/src/stores/policies'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'
import type {
  MihomoProxiesResponse,
  MihomoDelayMap,
  MihomoDelayResult
} from '../src/shared/mihomo-api'

const PROXIES: MihomoProxiesResponse = {
  proxies: {
    节点选择: { name: '节点选择', type: 'Selector', now: '香港 01', all: ['香港 01', '香港 02', 'DIRECT'] },
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
  let selectProxy: ReturnType<typeof vi.fn>
  let delayTest: ReturnType<typeof vi.fn>
  let groupDelayTest: ReturnType<typeof vi.fn>
  let patchConfig: ReturnType<typeof vi.fn>
  let getConfig: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    getProxies = vi.fn()
    selectProxy = vi.fn()
    delayTest = vi.fn()
    groupDelayTest = vi.fn()
    patchConfig = vi.fn()
    getConfig = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = {
      desktop: {
        mihomo: { getProxies, selectProxy, delayTest, groupDelayTest, patchConfig, getConfig }
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
    expect(store.groups.map((group) => group.name)).toEqual(['节点选择'])
    expect(store.selectedGroup).toBe('节点选择')
    expect(store.selectedMember).toBe('香港 01')
  })

  it('selects a node optimistically and keeps it on success', async () => {
    getProxies.mockResolvedValue(PROXIES)
    selectProxy.mockResolvedValue(undefined)
    const store = usePoliciesStore()
    await store.load()
    await store.selectNode('香港 02')
    expect(store.selectedMember).toBe('香港 02')
    expect(selectProxy).toHaveBeenCalledWith('节点选择', '香港 02')
  })

  it('rolls back the optimistic selection on failure', async () => {
    getProxies.mockResolvedValue(PROXIES)
    selectProxy.mockRejectedValue(error(ProtocolErrorCode.UPSTREAM_HTTP_ERROR))
    const store = usePoliciesStore()
    await store.load()
    await expect(store.selectNode('香港 02')).rejects.toThrow(ProtocolError)
    expect(store.selectedMember).toBe('香港 01')
    expect(store.panelError).toBe('boom')
  })

  it('records an ok delay from a node test', async () => {
    getProxies.mockResolvedValue(PROXIES)
    delayTest.mockResolvedValue({ delay: 42 } satisfies MihomoDelayResult)
    const store = usePoliciesStore()
    await store.load()
    await store.testNode('香港 01')
    expect(store.nodeState('香港 01')).toEqual({ status: 'ok', delay: 42 })
  })

  it('classifies a timeout as timeout and other failure as unavailable', async () => {
    getProxies.mockResolvedValue(PROXIES)
    const store = usePoliciesStore()
    await store.load()
    delayTest.mockRejectedValueOnce(error(ProtocolErrorCode.UPSTREAM_TIMEOUT))
    await store.testNode('香港 02')
    expect(store.nodeState('香港 02').status).toBe('timeout')
    delayTest.mockRejectedValueOnce(error(ProtocolErrorCode.UPSTREAM_UNREACHABLE))
    await store.testNode('香港 01')
    expect(store.nodeState('香港 01').status).toBe('unavailable')
  })

  it('applies a group delay map and times out missing members', async () => {
    getProxies.mockResolvedValue(PROXIES)
    groupDelayTest.mockResolvedValue({ '香港 01': 42, DIRECT: 6 } satisfies MihomoDelayMap)
    const store = usePoliciesStore()
    await store.load()
    await store.testAll()
    expect(store.groupDelayStatus).toBe('ok')
    expect(store.nodeState('香港 01')).toEqual({ status: 'ok', delay: 42 })
    expect(store.nodeState('DIRECT')).toEqual({ status: 'ok', delay: 6 })
    expect(store.nodeState('香港 02').status).toBe('timeout')
  })

  it('reports a group delay failure and marks all members unavailable', async () => {
    getProxies.mockResolvedValue(PROXIES)
    groupDelayTest.mockRejectedValue(error(ProtocolErrorCode.UPSTREAM_HTTP_ERROR))
    const store = usePoliciesStore()
    await store.load()
    await store.testAll()
    expect(store.groupDelayStatus).toBe('error')
    expect(store.nodeState('香港 01').status).toBe('unavailable')
  })

  it('patches the mode optimistically and rolls back on failure', async () => {
    getProxies.mockResolvedValue(PROXIES)
    patchConfig.mockResolvedValue(undefined)
    const store = usePoliciesStore()
    await store.load()
    await store.setMode('global')
    expect(store.mode).toBe('global')
    expect(patchConfig).toHaveBeenCalledWith({ mode: 'global' })
    patchConfig.mockRejectedValueOnce(error(ProtocolErrorCode.UPSTREAM_HTTP_ERROR))
    await store.setMode('direct')
    expect(store.mode).toBe('global')
  })

  it('marks the store as error when loading proxies fails', async () => {
    getProxies.mockRejectedValue(error(ProtocolErrorCode.UPSTREAM_UNREACHABLE))
    const store = usePoliciesStore()
    await store.load()
    expect(store.status).toBe('error')
    expect(store.lastError).toBe('boom')
  })
})
