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
        kernelEnabled:
          typeof patch.kernelEnabled === 'boolean' ? patch.kernelEnabled : current.kernelEnabled,
        kernelChannel:
          patch.kernelChannel === 'stable' || patch.kernelChannel === 'specific'
            ? patch.kernelChannel
            : current.kernelChannel,
        kernelSpecificVersion:
          typeof patch.kernelSpecificVersion === 'string'
            ? patch.kernelSpecificVersion
            : current.kernelSpecificVersion
      }
      await this.write(next)
      return next
    })
  }

  private async read(): Promise<AppSettings> {
    try {
      return parseAppSettings(await readFile(this.filePath, 'utf8'))
    } catch {
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
