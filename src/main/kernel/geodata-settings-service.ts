import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { stringify } from 'yaml'
import type { GeodataSettings } from '@shared/geodata'
import { buildGeodataBlock, coerceGeodataSettings } from '@shared/geodata'
import type { GeodataSettingsGateway } from '@shared/gateways'

/** Filename of the persisted typed controlled-geodata-settings model. */
export const GEODATA_SETTINGS_FILE = 'geodata-settings.json'

/**
 * Durable single-model store for the typed controlled geodata settings.
 *
 * Writes go through a temp-file + atomic rename so a crash mid-write never
 * leaves a truncated document, and a serial queue keeps concurrent requests from
 * interleaving. The model is lazy-loaded at first use and coalesced by
 * {@link coerceGeodataSettings}, so a stale or hand-edited file never crashes the
 * renderer.
 */
export class GeodataSettingsService implements GeodataSettingsGateway {
  private settings: GeodataSettings | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly appDataBase: string) {}

  get(): Promise<GeodataSettings> {
    return this.serial(async () => ({ ...(await this.ensureLoaded()) }))
  }

  set(input: GeodataSettings): Promise<GeodataSettings> {
    return this.serial(async () => {
      this.settings = coerceGeodataSettings(input)
      await this.persist()
      return { ...this.settings }
    })
  }

  /** Render the allowlisted mihomo geodata keys a model would produce (no writes). */
  preview(input: GeodataSettings): string {
    return stringify(buildGeodataBlock(coerceGeodataSettings(input)))
  }

  /** Return the persisted model (lazily loaded). */
  async getRaw(): Promise<GeodataSettings> {
    return this.serial(async () => ({ ...(await this.ensureLoaded()) }))
  }

  private async ensureLoaded(): Promise<GeodataSettings> {
    if (this.settings) return this.settings
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      this.settings = coerceGeodataSettings(parsed)
    } catch {
      this.settings = coerceGeodataSettings(undefined)
    }
    return this.settings
  }

  private async persist(): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const tmp = join(this.appDataBase, `.${GEODATA_SETTINGS_FILE}.${Date.now()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private get filePath(): string {
    return join(this.appDataBase, GEODATA_SETTINGS_FILE)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
