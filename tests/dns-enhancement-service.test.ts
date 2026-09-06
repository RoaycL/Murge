import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { DnsEnhancementService, DNS_ENHANCEMENT_FILE } from '../src/main/kernel/dns/dns-enhancement-service'
import { EMPTY_DNS_ENHANCEMENT } from '@shared/dns'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dns-enhancement-'))
}

describe('DnsEnhancementService', () => {
  it('returns safe defaults before anything is persisted', async () => {
    const dir = await makeDir()
    const service = new DnsEnhancementService(dir)
    const snapshot = await service.get()
    expect(snapshot.enhancement).toEqual(EMPTY_DNS_ENHANCEMENT)
  })

  it('persists atomically and reloads from disk', async () => {
    const dir = await makeDir()
    const service = new DnsEnhancementService(dir)
    await service.set({ ...EMPTY_DNS_ENHANCEMENT, enabled: true, fakeIpRange: '10.0.0.0/8' })

    const reloaded = new DnsEnhancementService(dir)
    const snapshot = await reloaded.get()
    expect(snapshot.enhancement.enabled).toBe(true)
    expect(snapshot.enhancement.fakeIpRange).toBe('10.0.0.0/8')

    const raw = await readFile(join(dir, DNS_ENHANCEMENT_FILE), 'utf8')
    expect(JSON.parse(raw).enhancement.enabled).toBe(true)
  })

  it('coerces a stale or hand-edited file instead of crashing', async () => {
    const dir = await makeDir()
    const service = new DnsEnhancementService(dir)
    await service.set(EMPTY_DNS_ENHANCEMENT)
    // Simulate a corrupt file.
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(dir, DNS_ENHANCEMENT_FILE), '{not json', 'utf8'))
    const reloaded = new DnsEnhancementService(dir)
    const snapshot = await reloaded.get()
    expect(snapshot.enhancement).toEqual(EMPTY_DNS_ENHANCEMENT)
  })

  it('migrates the old wildcard blacklist default without changing custom filters', async () => {
    const dir = await makeDir()
    const legacy = {
      ...EMPTY_DNS_ENHANCEMENT,
      fakeIpFilter: ['*', ...EMPTY_DNS_ENHANCEMENT.fakeIpFilter]
    }
    await writeFile(join(dir, DNS_ENHANCEMENT_FILE), JSON.stringify({ enhancement: legacy }), 'utf8')
    const migrated = await new DnsEnhancementService(dir).get()
    expect(migrated.enhancement.fakeIpFilter).toEqual(EMPTY_DNS_ENHANCEMENT.fakeIpFilter)

    const customDir = await makeDir()
    const custom = { ...legacy, fakeIpFilter: [...legacy.fakeIpFilter, '+.example.com'] }
    await writeFile(join(customDir, DNS_ENHANCEMENT_FILE), JSON.stringify({ enhancement: custom }), 'utf8')
    expect((await new DnsEnhancementService(customDir).get()).enhancement.fakeIpFilter).toContain('*')
  })

  it('preview renders a redacted yaml dns block without writing', async () => {
    const dir = await makeDir()
    const service = new DnsEnhancementService(dir)
    const preview = service.preview({
      ...EMPTY_DNS_ENHANCEMENT,
      enabled: true,
      nameserver: ['https://user:pass@1.1.1.1/dns-query']
    })
    expect(preview).toContain('dns:')
    expect(preview).toContain('https://***@1.1.1.1/dns-query')
    // No persistence happened for a preview.
    const reloaded = new DnsEnhancementService(dir)
    expect((await reloaded.get()).enhancement).toEqual(EMPTY_DNS_ENHANCEMENT)
  })

  it('applyToDocument merges when enabled and returns base when disabled', async () => {
    const base = 'port: 7890\nmode: rule\ndns:\n  enable: false\n'
    const dir = await makeDir()
    const service = new DnsEnhancementService(dir)
    await service.set({ ...EMPTY_DNS_ENHANCEMENT, enabled: true })
    const merged = await service.applyToDocument(base)
    expect((parse(merged) as Record<string, unknown>).dns).toMatchObject({ enable: true, 'enhanced-mode': 'fake-ip' })

    await service.set({ ...EMPTY_DNS_ENHANCEMENT, enabled: false })
    expect(await service.applyToDocument(base)).toBe(base)
  })
})
