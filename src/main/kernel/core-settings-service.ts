import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { stringify } from 'yaml'
import type { CoreSettings } from '@shared/core-settings'
import { buildCoreSettingsBlock, coerceCoreSettings } from '@shared/core-settings'
import type { CoreSettingsGateway } from '@shared/gateways'

/** Filename of the persisted typed controlled-core-settings model. */
export const CORE_SETTINGS_FILE = 'core-settings.json'
const CORE_SETTINGS_STORAGE_VERSION = 2

function migratePersistedSettings(input: unknown): { settings: CoreSettings; changed: boolean } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { settings: coerceCoreSettings(input), changed: false }
  }
  const source = input as Record<string, unknown>
  const changed = source.storageVersion !== CORE_SETTINGS_STORAGE_VERSION
  // v0.9.0 accidentally reversed Clash Party's HTTP and mixed defaults. Only
  // migrate that exact tuple from an unversioned file; all custom combinations
  // remain untouched.
  const candidate = changed &&
    source.mixedPort === 7892 && source.socksPort === 7891 && source.httpPort === 7890
      ? { ...source, mixedPort: 7890, httpPort: 7892 }
      : source
  return { settings: coerceCoreSettings(candidate), changed }
}

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
    const settings = coerceCoreSettings(input)
    return stringify({
      'mixed-port': settings.mixedPort,
      'socks-port': settings.socksPort,
      port: settings.httpPort,
      'external-controller': `${settings.controllerHost}:${settings.controllerPort}`,
      secret: settings.controllerSecret || '（下次启动时自动生成）',
      'allow-lan': settings.allowLan,
      'bind-address': settings.allowLan ? '*' : '127.0.0.1',
      ...(settings.controllerPanel ? {
        'external-ui': 'ui',
        'external-ui-name': 'metacubexd',
        'external-ui-url': 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip'
      } : {}),
      ...(settings.enabled ? buildCoreSettingsBlock(settings) : {})
    })
  }

  /** Return the persisted model (lazily loaded). */
  async getRaw(): Promise<CoreSettings> {
    return this.serial(async () => ({ ...(await this.ensureLoaded()) }))
  }

  private async ensureLoaded(): Promise<CoreSettings> {
    if (this.settings) return this.settings
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      const migrated = migratePersistedSettings(parsed)
      this.settings = migrated.settings
      if (migrated.changed) await this.persist()
    } catch {
      this.settings = coerceCoreSettings(undefined)
    }
    return this.settings
  }

  private async persist(): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const tmp = join(this.appDataBase, `.${CORE_SETTINGS_FILE}.${Date.now()}.tmp`)
    await writeFile(tmp, `${JSON.stringify({ storageVersion: CORE_SETTINGS_STORAGE_VERSION, ...this.settings }, null, 2)}\n`, 'utf8')
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
