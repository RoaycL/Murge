/** A single captured output line (or stdio chunk) from the kernel. */
export interface KernelLog {
  id: number
  stream: 'stdout' | 'stderr'
  text: string
  at: number
}

/**
 * Bounded, rolling capture of kernel stdout/stderr.
 *
 * The buffer keeps a hard byte cap and an entry cap, dropping the oldest
 * entries once either is exceeded, so a chatty kernel cannot exhaust memory.
 * It is intentionally small and dependency-free so it can be unit tested and
 * reused outside the supervisor.
 */
export class BoundedLogBuffer {
  private entries: KernelLog[] = []
  private bytes = 0
  private nextId = 0
  private readonly maxBytes: number
  private readonly maxEntries: number

  constructor(maxBytes = 256 * 1024, maxEntries = 4000) {
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
  }

  append(stream: 'stdout' | 'stderr', text: string): void {
    if (text.length === 0) return
    this.entries.push({ id: this.nextId++, stream, text, at: Date.now() })
    this.bytes += Buffer.byteLength(text, 'utf8')
    this.rotate()
  }

  /** Return up to `limit` most recent entries, oldest-first. */
  snapshot(limit = this.maxEntries): KernelLog[] {
    return this.entries.slice(-limit)
  }

  clear(): void {
    this.entries = []
    this.bytes = 0
  }

  get size(): number {
    return this.bytes
  }

  get length(): number {
    return this.entries.length
  }

  private rotate(): void {
    while (this.entries.length > 0 && (this.bytes > this.maxBytes || this.entries.length > this.maxEntries)) {
      const removed = this.entries.shift()
      if (removed) this.bytes -= Buffer.byteLength(removed.text, 'utf8')
    }
  }
}
