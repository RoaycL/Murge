import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileSystemUsageHistoryStore,
  InMemoryUsageHistoryStore,
  resolveUsageHistoryPath,
  USAGE_HISTORY_FILE
} from '../src/main/services/usage-history-store'
import { USAGE_MAX_BUCKETS } from '../src/shared/usage'

const HOUR = 3_600_000

describe('usage-history store', () => {
  describe('path resolution', () => {
    it('places the database in the usage-history directory', () => {
      expect(resolveUsageHistoryPath('/tmp/appdata-base')).toBe(
        join('/tmp/appdata-base', 'usage-history', USAGE_HISTORY_FILE)
      )
    })
  })

  describe('InMemoryUsageHistoryStore', () => {
    it('defaults to an empty database and round-trips a write', async () => {
      const store = new InMemoryUsageHistoryStore()
      expect(await store.read()).toEqual([])
      await store.write([{ bucketStart: HOUR, up: 1, down: 2, count: 3 }])
      expect(await store.read()).toEqual([{ bucketStart: HOUR, up: 1, down: 2, count: 3 }])
    })

    it('copies buckets on write (does not share a reference)', async () => {
      const store = new InMemoryUsageHistoryStore()
      const value = [{ bucketStart: HOUR, up: 1, down: 2, count: 3 }]
      await store.write(value)
      value.push({ bucketStart: HOUR * 2, up: 0, down: 0, count: 0 })
      expect(await store.read()).toHaveLength(1)
    })
  })

  describe('FileSystemUsageHistoryStore', () => {
    let dir: string
    let store: FileSystemUsageHistoryStore

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'mihomo-usage-'))
      store = FileSystemUsageHistoryStore.forAppDataBase(dir)
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('returns an empty database when no file exists', async () => {
      expect(await store.read()).toEqual([])
    })

    it('round-trips written buckets through disk, sorted and bounded', async () => {
      await store.write([
        { bucketStart: HOUR * 2, up: 1, down: 2, count: 1 },
        { bucketStart: HOUR, up: 3, down: 4, count: 2 }
      ])
      const out = await store.read()
      expect(out.map((b) => b.bucketStart)).toEqual([HOUR, HOUR * 2])
    })

    it('writes a single-stage atomic JSON payload', async () => {
      await store.write([{ bucketStart: HOUR, up: 5, down: 6, count: 1 }])
      const raw = await readFile(resolveUsageHistoryPath(dir), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed).toEqual([{ bucketStart: HOUR, up: 5, down: 6, count: 1 }])
    })

    it('coerces a malformed file to the safe empty database', async () => {
      await mkdir(join(dir, 'usage-history'), { recursive: true })
      await writeFile(resolveUsageHistoryPath(dir), '{not-json', 'utf8')
      expect(await store.read()).toEqual([])
    })

    it('coerces a partial entry by dropping it', async () => {
      await mkdir(join(dir, 'usage-history'), { recursive: true })
      await writeFile(resolveUsageHistoryPath(dir), JSON.stringify([{ bucketStart: HOUR, up: 'bad' }]), 'utf8')
      expect(await store.read()).toEqual([])
    })

    it('trims a runaway file to the bounded cap', async () => {
      const oversized = Array.from({ length: USAGE_MAX_BUCKETS + 3 }, (_, i) => ({
        bucketStart: i * HOUR,
        up: i,
        down: 0,
        count: 1
      }))
      await store.write(oversized)
      const out = await store.read()
      expect(out).toHaveLength(USAGE_MAX_BUCKETS)
    })
  })
})
