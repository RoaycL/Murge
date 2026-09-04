import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProxySelectionStore, PROXY_SELECTIONS_FILE } from '../src/main/profiles/proxy-selection-store'
import { ProxySelectionService } from '../src/main/services/proxy-selection-service'
import { ProxySelectionGateway } from '../src/main/services/proxy-selection-gateway'
import type { MihomoGateway, ProfileGateway } from '../src/shared/gateways'
import type { MihomoProxiesResponse } from '../src/shared/mihomo-api'
import type { ProfileMeta } from '../src/shared/profiles'

function meta(id: string, active: boolean): ProfileMeta {
  return { id, name: id, source: { type: 'manual' }, size: 1, createdAt: 1, updatedAt: 1, active }
}

function proxiesResponse(): MihomoProxiesResponse {
  return {
    proxies: {
      节点选择: { name: '节点选择', type: 'Selector', now: '香港 01', all: ['香港 01', '香港 02', '日本 01'] },
      自动选择: { name: '自动选择', type: 'URLTest', now: '香港 01', all: ['香港 01', '香港 02'] },
      DIRECT: { name: 'DIRECT', type: 'Direct' }
    }
  }
}

function mihomoStub(): MihomoGateway & { selectProxy: ReturnType<typeof vi.fn> } {
  return {
    selectProxy: vi.fn().mockResolvedValue(undefined),
    getProxies: vi.fn().mockResolvedValue(proxiesResponse())
  } as unknown as MihomoGateway & { selectProxy: ReturnType<typeof vi.fn> }
}

function profilesStub(activeId: string | null): ProfileGateway {
  return {
    listProfiles: vi.fn().mockResolvedValue(activeId ? [meta(activeId, true)] : [meta('p1', false)])
  } as unknown as ProfileGateway
}

describe('ProxySelectionStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proxy-selections-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips selections per profile and isolates profiles', async () => {
    const store = new ProxySelectionStore(dir)
    await store.set('p1', '节点选择', '香港 02')
    await store.set('p2', '节点选择', '日本 01')
    expect(await store.get('p1')).toEqual({ 节点选择: '香港 02' })
    expect(await store.get('p2')).toEqual({ 节点选择: '日本 01' })
    expect(await store.get('p3')).toEqual({})
  })

  it('returns an empty map for a missing or corrupt file (fail-open)', async () => {
    const store = new ProxySelectionStore(dir)
    expect(await store.get('p1')).toEqual({})
    await writeFile(join(dir, PROXY_SELECTIONS_FILE), '{ not json', 'utf8')
    expect(await store.get('p1')).toEqual({})
  })

  it('drops non-string node names from a hand-edited file', async () => {
    await writeFile(
      join(dir, PROXY_SELECTIONS_FILE),
      JSON.stringify({ p1: { 节点选择: '香港 02', bad: 42, nullish: null } }),
      'utf8'
    )
    expect(await new ProxySelectionStore(dir).get('p1')).toEqual({ 节点选择: '香港 02' })
  })

  it('deleteProfile removes only that profile', async () => {
    const store = new ProxySelectionStore(dir)
    await store.set('p1', 'g', 'n1')
    await store.set('p2', 'g', 'n2')
    await store.deleteProfile('p1')
    expect(await store.get('p1')).toEqual({})
    expect(await store.get('p2')).toEqual({ g: 'n2' })
    const onDisk = JSON.parse(await readFile(join(dir, PROXY_SELECTIONS_FILE), 'utf8')) as Record<string, unknown>
    expect('p1' in onDisk).toBe(false)
  })
})

describe('ProxySelectionService', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proxy-selections-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('records the accepted selection under the ACTIVE profile', async () => {
    const store = new ProxySelectionStore(dir)
    const service = new ProxySelectionService(mihomoStub(), profilesStub('p1'), store)
    service.recordSelection('节点选择', '香港 02')
    await vi.waitFor(async () => expect(await store.get('p1')).toEqual({ 节点选择: '香港 02' }))
  })

  it('records nothing when no profile is active', async () => {
    const store = new ProxySelectionStore(dir)
    const service = new ProxySelectionService(mihomoStub(), profilesStub(null), store)
    service.recordSelection('节点选择', '香港 02')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await store.get('p1')).toEqual({})
  })

  it('restores only remembered, still-valid, changed selections', async () => {
    const store = new ProxySelectionStore(dir)
    await store.set('p1', '节点选择', '香港 02')
    await store.set('p1', '不存在的组', '香港 01')
    await store.set('p1', '自动选择', '香港 01') // already current -> no PUT
    const mihomo = mihomoStub()
    const service = new ProxySelectionService(mihomo, profilesStub('p1'), store)
    const restored = await service.restoreSelections()
    expect(restored).toBe(1)
    expect(mihomo.selectProxy).toHaveBeenCalledTimes(1)
    expect(mihomo.selectProxy).toHaveBeenCalledWith('节点选择', '香港 02')
  })

  it('skips a remembered node the (updated) config no longer offers', async () => {
    const store = new ProxySelectionStore(dir)
    await store.set('p1', '节点选择', '已下架节点')
    const mihomo = mihomoStub()
    const service = new ProxySelectionService(mihomo, profilesStub('p1'), store)
    expect(await service.restoreSelections()).toBe(0)
    expect(mihomo.selectProxy).not.toHaveBeenCalled()
  })

  it('a failing group never aborts the remaining restores', async () => {
    const store = new ProxySelectionStore(dir)
    await store.set('p1', '节点选择', '香港 02')
    await store.set('p1', '自动选择', '香港 02')
    const mihomo = mihomoStub()
    mihomo.selectProxy
      .mockRejectedValueOnce(new Error('group gone'))
      .mockResolvedValueOnce(undefined)
    const service = new ProxySelectionService(mihomo, profilesStub('p1'), store)
    expect(await service.restoreSelections()).toBe(1)
    expect(mihomo.selectProxy).toHaveBeenCalledTimes(2)
  })
})

describe('ProxySelectionGateway', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proxy-selections-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('caches a selection only after the controller accepts it', async () => {
    const store = new ProxySelectionStore(dir)
    const inner = mihomoStub()
    const service = new ProxySelectionService(inner, profilesStub('p1'), store)
    const gateway = new ProxySelectionGateway(inner, service)

    await gateway.selectProxy('节点选择', '香港 02')
    expect(inner.selectProxy).toHaveBeenCalledWith('节点选择', '香港 02')
    await vi.waitFor(async () => expect(await store.get('p1')).toEqual({ 节点选择: '香港 02' }))
  })

  it('does NOT cache a rejected selection and propagates the error', async () => {
    const store = new ProxySelectionStore(dir)
    const inner = mihomoStub()
    inner.selectProxy.mockRejectedValueOnce(new Error('no such group'))
    const service = new ProxySelectionService(inner, profilesStub('p1'), store)
    const gateway = new ProxySelectionGateway(inner, service)

    await expect(gateway.selectProxy('坏组', 'x')).rejects.toThrow('no such group')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await store.get('p1')).toEqual({})
  })

  it('delegates reads untouched', async () => {
    const inner = mihomoStub()
    const gateway = new ProxySelectionGateway(inner, new ProxySelectionService(inner, profilesStub('p1'), new ProxySelectionStore(dir)))
    const result = await gateway.getProxies()
    expect(result.proxies['节点选择'].type).toBe('Selector')
    expect(inner.getProxies).toHaveBeenCalled()
  })
})
