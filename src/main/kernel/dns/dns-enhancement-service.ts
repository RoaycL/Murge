import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { stringify } from 'yaml'
import type { DnsEnhancement, DnsSnapshot } from '@shared/dns'
import { buildDnsBlock, coerceDnsEnhancement, redactDnsEnhancement } from '@shared/dns'
import type { DnsEnhancementGateway } from '@shared/gateways'
import { applyDnsEnhancementToDocument } from './apply-dns'

/** Filename of the persisted typed DNS enhancement. */
export const DNS_ENHANCEMENT_FILE = 'dns-enhancement.json'

/**
 * Durable single-model store for the typed DNS enhancement.
 *
 * Writes go through a temp-file + atomic rename so a crash mid-write never
 * leaves a truncated document, and a serial queue keeps concurrent requests from
 * interleaving. The model is lazy-loaded at first use and coalesced by
 * {@link coerceDnsEnhancement}, so a stale or hand-edited file never crashes the
 * renderer.
 */
export class DnsEnhancementService implements DnsEnhancementGateway {
  private enhancement: DnsEnhancement | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly appDataBase: string) {}

  get(): Promise<DnsSnapshot> {
    return this.serial(async () => ({ enhancement: { ...(await this.ensureLoaded()) } }))
  }

  set(input: DnsEnhancement): Promise<DnsSnapshot> {
    return this.serial(async () => {
      this.enhancement = coerceDnsEnhancement(input)
      await this.persist()
      return { enhancement: { ...this.enhancement } }
    })
  }

  /** Render a redacted YAML preview of the `dns:` block a model would produce. */
  preview(input: DnsEnhancement): string {
    return stringify({ dns: buildDnsBlock(redactDnsEnhancement(coerceDnsEnhancement(input))) })
  }

  /** Apply the persisted enhancement to a profile document (kernel pipeline). */
  async applyToDocument(base: string): Promise<string> {
    const snapshot = await this.get()
    return applyDnsEnhancementToDocument(base, snapshot.enhancement).text
  }

  private async ensureLoaded(): Promise<DnsEnhancement> {
    if (this.enhancement) return this.enhancement
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      const source = (parsed as { enhancement?: unknown })?.enhancement
      this.enhancement = coerceDnsEnhancement(source)
    } catch {
      this.enhancement = coerceDnsEnhancement(undefined)
    }
    return this.enhancement
  }

  private async persist(): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const snapshot: DnsSnapshot = { enhancement: this.enhancement! }
    const tmp = join(this.appDataBase, `.${DNS_ENHANCEMENT_FILE}.${Date.now()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private get filePath(): string {
    return join(this.appDataBase, DNS_ENHANCEMENT_FILE)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
