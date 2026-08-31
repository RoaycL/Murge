import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { stringify } from 'yaml'
import type { SnifferEnhancement, SnifferSnapshot } from '@shared/sniffer'
import { buildSnifferBlock, coerceSnifferEnhancement } from '@shared/sniffer'
import type { SnifferEnhancementGateway } from '@shared/gateways'
import { applySnifferEnhancementToDocument } from './apply-sniffer'

/** Filename of the persisted typed sniffer enhancement. */
export const SNIFFER_ENHANCEMENT_FILE = 'sniffer-enhancement.json'

/**
 * Durable single-model store for the typed sniffer enhancement.
 *
 * Writes go through a temp-file + atomic rename so a crash mid-write never
 * leaves a truncated document, and a serial queue keeps concurrent requests from
 * interleaving. The model is lazy-loaded at first use and coalesced by
 * {@link coerceSnifferEnhancement}, so a stale or hand-edited file never crashes
 * the renderer.
 */
export class SnifferEnhancementService implements SnifferEnhancementGateway {
  private enhancement: SnifferEnhancement | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly appDataBase: string) {}

  get(): Promise<SnifferSnapshot> {
    return this.serial(async () => ({ enhancement: { ...(await this.ensureLoaded()) } }))
  }

  set(input: SnifferEnhancement): Promise<SnifferSnapshot> {
    return this.serial(async () => {
      this.enhancement = coerceSnifferEnhancement(input)
      await this.persist()
      return { enhancement: { ...this.enhancement } }
    })
  }

  /** Render a YAML preview of the `sniffer:` block a model would produce. */
  preview(input: SnifferEnhancement): string {
    return stringify({ sniffer: buildSnifferBlock(coerceSnifferEnhancement(input)) })
  }

  /** Apply the persisted enhancement to a profile document (kernel pipeline). */
  async applyToDocument(base: string): Promise<string> {
    const snapshot = await this.get()
    return applySnifferEnhancementToDocument(base, snapshot.enhancement).text
  }

  private async ensureLoaded(): Promise<SnifferEnhancement> {
    if (this.enhancement) return this.enhancement
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      const source = (parsed as { enhancement?: unknown })?.enhancement
      this.enhancement = coerceSnifferEnhancement(source)
    } catch {
      this.enhancement = coerceSnifferEnhancement(undefined)
    }
    return this.enhancement
  }

  private async persist(): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const snapshot: SnifferSnapshot = { enhancement: this.enhancement! }
    const tmp = join(this.appDataBase, `.${SNIFFER_ENHANCEMENT_FILE}.${Date.now()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private get filePath(): string {
    return join(this.appDataBase, SNIFFER_ENHANCEMENT_FILE)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
