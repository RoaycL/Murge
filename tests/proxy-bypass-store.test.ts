import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileSystemProxyBypassStore,
  InMemoryProxyBypassStore,
  resolveSystemProxyBypassPath,
  SYSTEM_PROXY_BYPASS_FILE
} from '../src/main/system-proxy/proxy-bypass-store'

describe('proxy-bypass store', () => {
  describe('path resolution', () => {
    it('places the policy in the system-proxy directory', () => {
      expect(resolveSystemProxyBypassPath('/tmp/appdata-base')).toBe(
        join('/tmp/appdata-base', 'system-proxy', SYSTEM_PROXY_BYPASS_FILE)
      )
    })
  })

  describe('InMemoryProxyBypassStore', () => {
    it('defaults to the EMPTY policy and round-trips a write', async () => {
      const store = new InMemoryProxyBypassStore()
      expect(await store.read()).toMatchObject({ enabled: false, customEntries: [] })
      await store.write({ enabled: true, customEntries: ['a.com'] })
      expect(await store.read()).toMatchObject({ enabled: true, customEntries: ['a.com'] })
    })

    it('copies arrays on write (does not share a reference)', async () => {
      const store = new InMemoryProxyBypassStore()
      const entries = ['a.com']
      await store.write({ enabled: true, customEntries: entries })
      entries.push('b.com')
      expect((await store.read()).customEntries).toEqual(['a.com'])
    })
  })

  describe('FileSystemProxyBypassStore', () => {
    let dir: string
    let store: FileSystemProxyBypassStore

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'mihomo-bypass-'))
      store = FileSystemProxyBypassStore.forAppDataBase(dir)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('returns the EMPTY policy when no file exists', async () => {
      expect(await store.read()).toMatchObject({ enabled: false, customEntries: [] })
    })

    it('round-trips a written policy through disk', async () => {
      await store.write({ enabled: true, customEntries: ['*.example.com', '10.*'] })
      const policy = await store.read()
      expect(policy).toMatchObject({ enabled: true, customEntries: ['*.example.com', '10.*'] })
    })

    it('writes a single-stage atomic JSON payload', async () => {
      await store.write({ enabled: true, customEntries: ['x.com'] })
      const raw = await readFile(resolveSystemProxyBypassPath(dir), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed).toEqual({ enabled: true, customEntries: ['x.com'] })
    })

    it('coerces a malformed file to the safe default', async () => {
      await mkdir(join(dir, 'system-proxy'), { recursive: true })
      await writeFile(resolveSystemProxyBypassPath(dir), '{not-json', 'utf8')
      expect(await store.read()).toMatchObject({ enabled: false, customEntries: [] })
    })

    it('coerces a partial file into a valid model', async () => {
      await mkdir(join(dir, 'system-proxy'), { recursive: true })
      await writeFile(resolveSystemProxyBypassPath(dir), JSON.stringify({ enabled: true }), 'utf8')
      expect(await store.read()).toMatchObject({ enabled: true, customEntries: [] })
    })
  })
})
