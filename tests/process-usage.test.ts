import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MihomoConnectionsSnapshot } from '../src/shared/mihomo-api'
import { UsageHistoryService } from '../src/main/services/usage-history-service'
import { FileSystemProcessUsageStore, InMemoryProcessUsageStore } from '../src/main/services/process-usage-store'
import { processUsageName } from '../src/shared/process-usage'

const TIME = 1_000_000_000
const snapshot = (rows: Array<[string, string, number, number]>): MihomoConnectionsSnapshot => ({
  downloadTotal: 0, uploadTotal: 0, memory: 0,
  connections: rows.map(([id, process, upload, download]) => ({ id, upload, download, metadata: { process } }))
} as MihomoConnectionsSnapshot)

describe('observed process usage', () => {
  it('keeps only an executable name even if a path is reported', () => {
    expect(processUsageName('C:\\Apps\\Browser.exe')).toBe('Browser.exe')
    expect(processUsageName('/opt/apps/browser')).toBe('browser')
  })
  it('uses the first snapshot as a restart baseline and then tracks counter deltas', async () => {
    const processStore = new InMemoryProcessUsageStore()
    const service = new UsageHistoryService({ now: () => TIME + 3_000, processStore, persistIntervalMs: 0 })
    await service.recordConnections(snapshot([['old', 'Browser.exe', 20, 30]]), TIME)
    expect(service.processRanking('24h').entries).toEqual([])
    await service.recordConnections(snapshot([['old', 'Browser.exe', 27, 49], ['new', 'Editor.exe', 3, 5]]), TIME + 1_000)
    await service.recordConnections(snapshot([['old', 'Browser.exe', 27, 49], ['new', 'Editor.exe', 3, 5]]), TIME + 2_000)
    expect(service.processRanking('24h').entries).toEqual([
      { name: 'Browser.exe', up: 7, down: 19, total: 26 },
      { name: 'Editor.exe', up: 3, down: 5, total: 8 }
    ])
    await service.flush()
    const reopened = new UsageHistoryService({ now: () => TIME + 3_000, processStore })
    await reopened.init()
    await reopened.recordConnections(snapshot([['old', 'Browser.exe', 27, 49]]), TIME + 3_000)
    expect(reopened.processRanking('24h').observedBytes).toBe(34)
    await reopened.clear()
    expect((await processStore.read())).toEqual([])
  })

  it('persists a bounded local file without hosts or executable paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'murge-process-usage-'))
    try {
      const store = FileSystemProcessUsageStore.forAppDataBase(dir)
      await store.write([{ bucketStart: TIME - (TIME % 3_600_000), rows: [{ name: 'Browser.exe', up: 1, down: 2 }] }])
      expect(await store.read()).toHaveLength(1)
      const raw = await readFile(join(dir, 'usage-history', 'process-usage.json'), 'utf8')
      expect(raw).toContain('Browser.exe')
      expect(raw).not.toContain('processPath')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
