import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { SnifferEnhancementService, SNIFFER_ENHANCEMENT_FILE } from '../src/main/kernel/sniffer/sniffer-enhancement-service'
import { EMPTY_SNIFFER_ENHANCEMENT } from '@shared/sniffer'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sniffer-enhancement-'))
}

describe('SnifferEnhancementService', () => {
  it('returns safe defaults before anything is persisted', async () => {
    const dir = await makeDir()
    const service = new SnifferEnhancementService(dir)
    const snapshot = await service.get()
    expect(snapshot.enhancement).toEqual(EMPTY_SNIFFER_ENHANCEMENT)
  })

  it('persists atomically and reloads from disk', async () => {
    const dir = await makeDir()
    const service = new SnifferEnhancementService(dir)
    await service.set({ ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true, ports: { http: ['80'], tls: ['443'], quic: ['443'] } })

    const reloaded = new SnifferEnhancementService(dir)
    const snapshot = await reloaded.get()
    expect(snapshot.enhancement.enabled).toBe(true)
    expect(snapshot.enhancement.ports.http).toEqual(['80'])

    const raw = await readFile(join(dir, SNIFFER_ENHANCEMENT_FILE), 'utf8')
    expect(JSON.parse(raw).enhancement.enabled).toBe(true)
  })

  it('coerces a stale or hand-edited file instead of crashing', async () => {
    const dir = await makeDir()
    const service = new SnifferEnhancementService(dir)
    await service.set(EMPTY_SNIFFER_ENHANCEMENT)
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(dir, SNIFFER_ENHANCEMENT_FILE), '{not json', 'utf8'))
    const reloaded = new SnifferEnhancementService(dir)
    const snapshot = await reloaded.get()
    expect(snapshot.enhancement).toEqual(EMPTY_SNIFFER_ENHANCEMENT)
  })

  it('preview renders a yaml sniffer block without writing', async () => {
    const dir = await makeDir()
    const service = new SnifferEnhancementService(dir)
    const preview = service.preview({ ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true })
    expect(preview).toContain('sniffer:')
    expect(preview).toContain('override-destination')
    const reloaded = new SnifferEnhancementService(dir)
    expect((await reloaded.get()).enhancement).toEqual(EMPTY_SNIFFER_ENHANCEMENT)
  })

  it('applyToDocument merges when enabled and returns base when disabled', async () => {
    const base = 'port: 7890\nmode: rule\nsniffer:\n  enable: false\n'
    const dir = await makeDir()
    const service = new SnifferEnhancementService(dir)
    await service.set({ ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true })
    const merged = await service.applyToDocument(base)
    expect((parse(merged) as Record<string, unknown>).sniffer).toMatchObject({ enable: true, 'override-destination': false })

    await service.set({ ...EMPTY_SNIFFER_ENHANCEMENT, enabled: false })
    expect(await service.applyToDocument(base)).toBe(base)
  })
})
