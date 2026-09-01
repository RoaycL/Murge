import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { stringify } from 'yaml'
import type { CoreSettings } from '@shared/core-settings'
import { buildCoreSettingsBlock, coerceCoreSettings } from '@shared/core-settings'
import type { CoreSettingsGateway } from '@shared/gateways'

/** Filename of the persisted typed controlled-core-settings model. */
export const CORE_SETTINGS_FILE = 'core-settings.json'

/**
 * Durable single-model store for the typed controlled core settings.
 *
 * Writes go through a temp-file + atomic rename so a crash mid-write never
 * leaves a truncated document, and a serial queue keeps concurrent requests from
 * interleaving. The model is lazy-loaded at first use and coalesced by
 * {@link coerceCoreSettings}, so a stale or hand-edited file never crashes the
 * renderer.
 */
export class CoreSettingsService implements CoreSettingsGateway {
  private settings: CoreSettings | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly appDataBase: string) {}

  get(): Promise<CoreSettings> {
    return this.serial(async () => ({ ...(await this.ensureLoaded()) }))
  }

  set(input: CoreSettings): Promise<CoreSettings> {
    return this.serial(async () => {
      this.settings = coerceCoreSettings(input)
      await this.persist()
      return { ...this.settings }
    })
  }

  /** Render the allowlisted mihomo core keys a model would produce (no writes). */
  preview(input: CoreSettings): string {
    return stringify(buildCoreSettingsBlock(coerceCoreSettings(input)))
  }

  /** Return the persisted model (lazily loaded). */
  async getRaw(): Promise<CoreSettings> {
    return this.serial(async () => ({ ...(await this.ensureLoaded()) }))
  }

  private async ensureLoaded(): Promise<CoreSettings> {
    if (this.settings) return this.settings
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      this.settings = coerceCoreSettings(parsed)
    } catch {
      this.settings = coerceCoreSettings(undefined)
    }
    return this.settings
  }

  private async persist(): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const tmp = join(this.appDataBase, `.${CORE_SETTINGS_FILE}.${Date.now()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private get filePath(): string {
    return join(this.appDataBase, CORE_SETTINGS_FILE)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
