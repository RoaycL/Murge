import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import type { UsageBucket } from '../../shared/usage'
import { coerceUsageBuckets, USAGE_MAX_BUCKETS } from '../../shared/usage'

/**
 * How the bounded usage database is persisted. `read` always returns a valid,
 * sorted, bounded bucket list — an empty database is never an error.
 */
export interface UsageHistoryStore {
  read(): Promise<UsageBucket[]>
  write(buckets: UsageBucket[]): Promise<void>
}

export const USAGE_HISTORY_FILE = 'usage-history.json'

/** Resolve the bounded usage-history database file under the app-data base. */
export function resolveUsageHistoryPath(appDataBase: string): string {
  return join(appDataBase, 'usage-history', USAGE_HISTORY_FILE)
}

/**
 * File-backed bounded usage-history store. Writes are atomic (temp file in the
 * same directory, then rename) so a crash mid-write can never leave a
 * half-written payload, and reads are coalesced through
 * {@link coerceUsageBuckets} so a stale or hand-edited file is a safe empty
 * database rather than a hard failure — usage history is a convenience, not a
 * crash-recovery-critical value.
 */
export class FileSystemUsageHistoryStore implements UsageHistoryStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  static forAppDataBase(appDataBase: string): FileSystemUsageHistoryStore {
    return new FileSystemUsageHistoryStore(resolveUsageHistoryPath(appDataBase))
  }

  async read(): Promise<UsageBucket[]> {
    await this.queue
    await this.pruneStaleTemps()
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR') return coerceUsageBuckets(undefined)
      return coerceUsageBuckets(undefined)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return coerceUsageBuckets(undefined)
    }
    // Before 0.8.5 `count` meant one traffic sample and therefore saturated at
    // about 3600 per hourly bucket. Keep the byte history but reset that legacy
    // counter once; newly persisted buckets carry an explicit semantic marker.
    return coerceUsageBuckets(parsed, USAGE_MAX_BUCKETS).map((bucket) =>
      bucket.countType === 'connections'
        ? bucket
        : { ...bucket, count: 0, countType: 'connections' as const }
    )
  }

  write(buckets: UsageBucket[]): Promise<void> {
    const snapshot = buckets.map((bucket) => ({ ...bucket }))
    const result = this.queue.then(
      () => this.persist(snapshot),
      () => this.persist(snapshot)
    )
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(buckets: UsageBucket[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = join(dirname(this.filePath), `.${USAGE_HISTORY_FILE}.${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, `${JSON.stringify(buckets)}\n`, 'utf8')
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(tmp, this.filePath)
          return
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 4) throw error
          await delay(25 * (2 ** attempt))
        }
      }
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  }

  private async pruneStaleTemps(): Promise<void> {
    const directory = dirname(this.filePath)
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return
    }
    const prefix = `.${USAGE_HISTORY_FILE}.`
    await Promise.all(entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'))
      .map((entry) => unlink(join(directory, entry)).catch(() => undefined)))
  }
}

/** In-memory store for the dev build and unit tests. */
export class InMemoryUsageHistoryStore implements UsageHistoryStore {
  private value: UsageBucket[] = []

  async read(): Promise<UsageBucket[]> {
    return this.value.map((bucket) => ({ ...bucket }))
  }

  async write(buckets: UsageBucket[]): Promise<void> {
    this.value = buckets.map((bucket) => ({ ...bucket }))
  }
}
