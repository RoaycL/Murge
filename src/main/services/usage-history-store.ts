import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
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
  constructor(private readonly filePath: string) {}

  static forAppDataBase(appDataBase: string): FileSystemUsageHistoryStore {
    return new FileSystemUsageHistoryStore(resolveUsageHistoryPath(appDataBase))
  }

  async read(): Promise<UsageBucket[]> {
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
    return coerceUsageBuckets(parsed, USAGE_MAX_BUCKETS)
  }

  async write(buckets: UsageBucket[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = join(dirname(this.filePath), `.${USAGE_HISTORY_FILE}.${randomUUID()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(buckets)}\n`, 'utf8')
    await rename(tmp, this.filePath)
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
