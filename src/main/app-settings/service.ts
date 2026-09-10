import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { AppSettings } from '@shared/app-settings'
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '@shared/app-settings'
import type { AppSettingsGateway } from '@shared/gateways'

/** Filename of the persisted application-settings document. */
export const APP_SETTINGS_FILE = 'app-settings.json'

/**
 * Durable, atomic application-settings store in the brand-stable app-data
 * namespace. Reads fall back to the default when the file is absent or corrupt,
 * and writes use a temp-file + rename so a crash mid-write never leaves a
 * truncated settings document. Serialized by a local queue so concurrent IPC
 * writes cannot interleave.
 */
export class AppSettingsService implements AppSettingsGateway {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(settings: AppSettings) => void>()

  constructor(private readonly appDataBase: string) {}

  get(): Promise<AppSettings> {
    return this.serial(() => Promise.resolve(this.read()))
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.serial(async () => {
      const current = await this.read()
      const next: AppSettings = {
        autoStartKernel:
          typeof patch.autoStartKernel === 'boolean'
            ? patch.autoStartKernel
            : current.autoStartKernel,
        autoCheckUpdate:
          typeof patch.autoCheckUpdate === 'boolean'
            ? patch.autoCheckUpdate
            : current.autoCheckUpdate,
        systemProxyDesired:
          typeof patch.systemProxyDesired === 'boolean'
            ? patch.systemProxyDesired
            : current.systemProxyDesired,
        tunDesired:
          typeof patch.tunDesired === 'boolean' ? patch.tunDesired : current.tunDesired,
        kernelEnabled: true,
        kernelChannel:
          patch.kernelChannel === 'stable' || patch.kernelChannel === 'preview' || patch.kernelChannel === 'smart' || patch.kernelChannel === 'specific'
            ? patch.kernelChannel
            : current.kernelChannel,
        kernelSpecificVersion:
          typeof patch.kernelSpecificVersion === 'string'
            ? patch.kernelSpecificVersion
            : current.kernelSpecificVersion,
        delayTestUrlScope:
          patch.delayTestUrlScope === 'group' || patch.delayTestUrlScope === 'global'
            ? patch.delayTestUrlScope
            : current.delayTestUrlScope,
        delayTestUrl:
          typeof patch.delayTestUrl === 'string' ? patch.delayTestUrl : current.delayTestUrl,
        // Kept in the persisted schema for compatibility; login launches are
        // always hidden, so an older renderer cannot opt back into a popup.
        silentLaunch: true,
        closeToTray:
          typeof patch.closeToTray === 'boolean' ? patch.closeToTray : current.closeToTray,
        proxyGuard: typeof patch.proxyGuard === 'boolean' ? patch.proxyGuard : current.proxyGuard,
        subStoreEnabled:
          typeof patch.subStoreEnabled === 'boolean'
            ? patch.subStoreEnabled
            : current.subStoreEnabled,
        subStoreUseProxy:
          typeof patch.subStoreUseProxy === 'boolean'
            ? patch.subStoreUseProxy
            : current.subStoreUseProxy
      }
      await this.write(next)
      for (const listener of this.listeners) {
        try {
          listener({ ...next })
        } catch {
          // Preference persistence must not fail because an observer did.
        }
      }
      return next
    })
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async read(): Promise<AppSettings> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[app-settings] unable to read persisted settings:', error)
      }
      return { ...DEFAULT_APP_SETTINGS }
    }
    try {
      const decoded = JSON.parse(raw) as unknown
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new TypeError('settings document must be an object')
      }
      return parseAppSettings(raw)
    } catch (error) {
      // Preserve the damaged document for support/recovery instead of silently
      // allowing the next settings write to overwrite the only evidence.
      const quarantine = join(this.appDataBase, `${APP_SETTINGS_FILE}.corrupt-${Date.now()}`)
      try {
        await rename(this.filePath, quarantine)
        console.error(`[app-settings] quarantined invalid settings at ${quarantine}:`, error)
      } catch (quarantineError) {
        console.error('[app-settings] invalid settings could not be quarantined:', error, quarantineError)
      }
      return { ...DEFAULT_APP_SETTINGS }
    }
  }

  private async write(settings: AppSettings): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const tmp = join(this.appDataBase, `.${APP_SETTINGS_FILE}.${randomUUID()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private get filePath(): string {
    return join(this.appDataBase, APP_SETTINGS_FILE)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
