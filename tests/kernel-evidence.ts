import { mkdir, writeFile, rename, readFile, stat, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * What the CI watchdog (`if: always()` finally step) needs to reap the exact
 * mihomo process and assert cleanup. The controller secret must NEVER be stored
 * here — only the identity of the process and the ports it opened.
 */
export interface KernelEvidenceData {
  pid: number
  controllerPort: number
  mixedPort: number
  workspace: string
  configDir: string
}

/**
 * Durable, atomically-replaced evidence store for the CI watchdog.
 *
 * The evidence file is written on every supervisor PID change so the finally
 * step always sees the *current* process — not a stale PID from before a
 * watchdog restart. Each write is atomic (temp file + same-volume rename), so a
 * reader never observes a half-written document and a crash mid-write never
 * clobbers the last good value. Concurrent updates are serialized so a burst of
 * PID changes cannot interleave two in-flight writes.
 */
export class EvidenceFile {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  /** Atomically replace the evidence with `data`. */
  update(data: KernelEvidenceData): Promise<void> {
    const target = this.path
    const payload = JSON.stringify(data)
    const run = this.chain.then(() => this.writeAtomic(target, payload))
    // Keep the internal chain alive even if a write fails, so callers awaiting
    // `read()`/the chain are not stuck on a rejected promise.
    this.chain = run.catch(() => undefined)
    return run
  }

  private async writeAtomic(target: string, payload: string): Promise<void> {
    const dir = dirname(target)
    await mkdir(dir, { recursive: true }).catch(() => undefined)
    // The temp file lives in the SAME directory as the target so rename() is
    // an atomic same-volume move, never a cross-device copy.
    const tmp = join(
      dir,
      `mihomo-evidence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    )
    try {
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, target)
    } catch (error) {
      // Best-effort cleanup of the temp file; never leave a stray behind.
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Read the current evidence, or null when absent/corrupt. */
  async read(): Promise<KernelEvidenceData | null> {
    try {
      // Await any already-enqueued write so we never observe a stale value
      // while a supervisor PID change is still in flight.
      await this.chain
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as KernelEvidenceData
      if (typeof parsed?.pid !== 'number') return null
      return parsed
    } catch {
      return null
    }
  }

  async exists(): Promise<boolean> {
    try {
      await stat(this.path)
      return true
    } catch {
      return false
    }
  }
}
