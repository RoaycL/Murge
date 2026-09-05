import type { MihomoLogMessage } from '../../shared/mihomo-api'

/**
 * Main-process kernel log retention (design follows sparkle / clash-verge-rev /
 * clash-party: log capture must never depend on the logs page being open).
 *
 * mihomo's `/logs` endpoint is a LIVE TAIL with no history. Before this buffer
 * the only consumer of the log stream was the renderer's logs view, so every
 * line emitted while another view was mounted was lost forever — reproducing a
 * transient failure (a game session, a provider refresh) meant keeping the log
 * page open from before it happened. The buffer is tapped inside
 * {@link MihomoService} for EVERY parsed message, independent of who (if
 * anyone) is currently subscribed, and the renderer merges the snapshot with
 * the live event stream on connect.
 *
 * `seq` is strictly monotonic for the lifetime of the service instance and is
 * never reset — not even by `clear()` — because it is the deduplication key
 * between the snapshot channel and the live event channel. Eviction is FIFO
 * from the front once `capacity` is reached.
 */
export class MihomoLogBuffer {
  private readonly capacity: number
  private entries: MihomoLogMessage[] = []
  private nextSeq = 0

  constructor(capacity = 2000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('log buffer capacity must be a positive integer')
    }
    this.capacity = capacity
  }

  /**
   * Retain one message. The message object is mutated in place to carry its
   * `seq` so the live event channel and the retained copy expose the identical
   * sequence number to every consumer.
   */
  append(message: MihomoLogMessage): number {
    const seq = ++this.nextSeq
    message.seq = seq
    this.entries.push(message)
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
    return seq
  }

  /** All retained messages with `seq > afterSeq`, ascending. */
  snapshot(afterSeq = 0): MihomoLogMessage[] {
    if (afterSeq <= 0) return [...this.entries]
    if (this.entries.length === 0) return []
    // Fast path: the common query is "everything past the head of the ring".
    const first = this.entries[0].seq ?? 0
    if (first > afterSeq) return [...this.entries]
    let lo = 0
    let hi = this.entries.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((this.entries[mid].seq ?? 0) <= afterSeq) lo = mid + 1
      else hi = mid
    }
    return (this.entries[lo].seq ?? 0) > afterSeq ? this.entries.slice(lo) : []
  }

  /** Highest sequence number handed out so far (0 = nothing retained yet). */
  get lastSeq(): number {
    return this.nextSeq
  }

  /** Drop retained lines; sequence numbering continues uninterrupted. */
  clear(): void {
    this.entries = []
  }
}
