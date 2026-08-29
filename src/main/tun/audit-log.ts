export interface TunAuditEntry {
  sequence: number
  at: string
  event: string
  phase: string
  detailCode: string | null
}

const DETAIL_CODE = /^[A-Z0-9_.:-]{1,128}$/

/** In-memory diagnostic log only. It accepts machine codes, never arbitrary config or secret text. */
export class TunAuditLog {
  private entries: TunAuditEntry[] = []
  private bytes = 0
  private sequence = 0

  constructor(private readonly maxBytes = 128 * 1024, private readonly maxEntries = 1000) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0 || !Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError('TUN audit log limits must be positive integers')
    }
  }

  append(event: string, phase: string, detailCode: string | null = null, at = new Date()): void {
    if (detailCode !== null && !DETAIL_CODE.test(detailCode)) {
      throw new TypeError('TUN audit detailCode must be a bounded machine code')
    }
    const entry = { sequence: this.sequence++, at: at.toISOString(), event, phase, detailCode }
    this.entries.push(entry)
    this.bytes += this.byteLength(entry)
    while (this.entries.length > 0 && (this.entries.length > this.maxEntries || this.bytes > this.maxBytes)) {
      const removed = this.entries.shift()
      if (removed) this.bytes -= this.byteLength(removed)
    }
  }

  snapshot(limit = this.maxEntries): TunAuditEntry[] {
    return this.entries.slice(-Math.max(0, limit)).map((entry) => ({ ...entry }))
  }

  get size(): number { return this.bytes }
  get length(): number { return this.entries.length }

  private byteLength(entry: TunAuditEntry): number {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8')
  }
}
