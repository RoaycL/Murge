import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ProcessUsageBucket } from '../../shared/process-usage'
import { coerceProcessUsageBuckets } from '../../shared/process-usage'

export interface ProcessUsageStore {
  read(): Promise<ProcessUsageBucket[]>
  write(buckets: ProcessUsageBucket[]): Promise<void>
}

export class InMemoryProcessUsageStore implements ProcessUsageStore {
  private buckets: ProcessUsageBucket[] = []
  async read(): Promise<ProcessUsageBucket[]> { return structuredClone(this.buckets) }
  async write(buckets: ProcessUsageBucket[]): Promise<void> { this.buckets = structuredClone(buckets) }
}

/** An independent bounded database; old aggregate usage files stay compatible. */
export class FileSystemProcessUsageStore implements ProcessUsageStore {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}
  static forAppDataBase(base: string): FileSystemProcessUsageStore {
    return new FileSystemProcessUsageStore(join(base, 'usage-history', 'process-usage.json'))
  }
  async read(): Promise<ProcessUsageBucket[]> {
    await this.queue
    try { return coerceProcessUsageBuckets(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch { return [] }
  }
  write(buckets: ProcessUsageBucket[]): Promise<void> {
    const copy = structuredClone(buckets)
    const result = this.queue.then(() => this.persist(copy), () => this.persist(copy))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  private async persist(buckets: ProcessUsageBucket[]): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true })
    const temp = join(directory, `.process-usage.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, `${JSON.stringify(buckets)}\n`, { encoding: 'utf8', mode: 0o600 })
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temp, this.path)
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 4) throw error
          await delay(25 * (2 ** attempt))
        }
      }
    } finally { await unlink(temp).catch(() => undefined) }
  }
}
