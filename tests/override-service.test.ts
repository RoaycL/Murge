import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OverrideService, OVERRIDES_FILE } from '../src/main/kernel/overrides/override-service'

let dir: string | null = null
async function makeDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'murge-ovr-'))
  return dir
}

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = null
  }
})

describe('OverrideService', () => {
  it('starts empty', async () => {
    const service = new OverrideService(await makeDir())
    expect((await service.list()).items).toEqual([])
  })

  it('creates a global override with order 0', async () => {
    const service = new OverrideService(await makeDir())
    const snapshot = await service.create({ name: '规则', kind: 'yaml', scope: 'global', profileId: null, content: 'mode: rule' })
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0].name).toBe('规则')
    expect(snapshot.items[0].order).toBe(0)
    expect(snapshot.items[0].enabled).toBe(true)
    expect(snapshot.items[0].profileId).toBeNull()
  })

  it('separates global vs profile scope selection via effectiveOverrides', async () => {
    const service = new OverrideService(await makeDir())
    await service.create({ name: '全局', kind: 'yaml', scope: 'global', profileId: null, content: 'a: 1' })
    await service.create({ name: 'P1专属', kind: 'yaml', scope: 'profile', profileId: 'p1', content: 'b: 2' })
    await service.create({ name: 'P2专属', kind: 'yaml', scope: 'profile', profileId: 'p2', content: 'c: 3' })

    const p1 = service.effectiveOverrides('p1').map((i) => i.name)
    const p2 = service.effectiveOverrides('p2').map((i) => i.name)
    const none = service.effectiveOverrides(null).map((i) => i.name)
    expect(p1).toEqual(['全局', 'P1专属'])
    expect(p2).toEqual(['全局', 'P2专属'])
    expect(none).toEqual(['全局'])
  })

  it('excludes disabled overrides from effective selection', async () => {
    const service = new OverrideService(await makeDir())
    const snap = await service.create({ name: '停用的', kind: 'yaml', scope: 'global', profileId: null, content: 'a: 1' })
    await service.setEnabled(snap.items[0].id, false)
    expect(service.effectiveOverrides(null).map((i) => i.name)).toEqual([])
  })

  it('applies effective overrides to a base document through applyForProfile', async () => {
    const service = new OverrideService(await makeDir())
    await service.create({ name: '改mode', kind: 'yaml', scope: 'global', profileId: null, content: 'mode: global' })
    const text = await service.applyForProfile('mode: rule\nmixed-port: 7890\n', 'p1')
    expect(text).toContain('mode: global')
    expect(text).not.toContain('mode: rule')
  })

  it('reorders by move and keeps order sequential', async () => {
    const service = new OverrideService(await makeDir())
    const a = await service.create({ name: 'A', kind: 'yaml', scope: 'global', profileId: null, content: 'a: 1' })
    const b = await service.create({ name: 'B', kind: 'yaml', scope: 'global', profileId: null, content: 'b: 2' })
    const c = await service.create({ name: 'C', kind: 'yaml', scope: 'global', profileId: null, content: 'c: 3' })
    const idB = b.items[1].id
    const after = await service.move(idB, 'up')
    expect(after.items.map((i) => i.name)).toEqual(['B', 'A', 'C'])
    expect(after.items.map((i) => i.order)).toEqual([0, 1, 2])
  })

  it('removes an item and reindexes', async () => {
    const service = new OverrideService(await makeDir())
    const s = await service.create({ name: 'A', kind: 'yaml', scope: 'global', profileId: null, content: 'a: 1' })
    await service.create({ name: 'B', kind: 'yaml', scope: 'global', profileId: null, content: 'b: 2' })
    const after = await service.remove(s.items[0].id)
    expect(after.items.map((i) => i.name)).toEqual(['B'])
    expect(after.items[0].order).toBe(0)
  })

  it('updates preserve order and enabled state', async () => {
    const service = new OverrideService(await makeDir())
    const s = await service.create({ name: '旧', kind: 'yaml', scope: 'global', profileId: null, content: 'a: 1' })
    const id = s.items[0].id
    const after = await service.update(id, { name: '新', kind: 'js', scope: 'profile', profileId: 'p1', content: 'main=function(c){return c}' })
    expect(after.items[0].name).toBe('新')
    expect(after.items[0].kind).toBe('js')
    expect(after.items[0].scope).toBe('profile')
    expect(after.items[0].profileId).toBe('p1')
    expect(after.items[0].enabled).toBe(true)
    expect(after.items[0].order).toBe(0)
  })

  it('persists across instances', async () => {
    const dirPath = await makeDir()
    const first = new OverrideService(dirPath)
    await first.create({ name: '持久', kind: 'yaml', scope: 'global', profileId: null, content: 'mode: rule' })

    const second = new OverrideService(dirPath)
    const items = (await second.list()).items
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('持久')
    expect(second.effectiveOverrides(null).map((i) => i.name)).toEqual(['持久'])
  })

  it('recovers from a corrupt document (fail-open to empty)', async () => {
    const dirPath = await makeDir()
    // Place an invalid JSON file where the store expects its document.
    await writeFile(join(dirPath, OVERRIDES_FILE), '{ not json', 'utf8')
    const service = new OverrideService(dirPath)
    expect((await service.list()).items).toEqual([])
    // The store remains writable after a corrupt read.
    const snap = await service.create({ name: 'A', kind: 'yaml', scope: 'global', profileId: null, content: 'a: 1' })
    expect(snap.items).toHaveLength(1)
  })
})
