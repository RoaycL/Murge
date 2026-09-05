import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { stringify } from 'yaml'
import type { TunConfigModel, TunConfigSnapshot } from '@shared/tun-config'
import { EMPTY_TUN_CONFIG, LEGACY_TUN_MTU_DEFAULT, buildTunBlock, coerceTunConfig, coerceTunConfigSnapshot } from '@shared/tun-config'
import type { TunConfigGateway } from '@shared/gateways'

/** Filename of the persisted typed TUN configuration model. */
export const TUN_CONFIG_FILE = 'tun-config.json'

/**
 * Durable single-model store for the typed TUN configuration.
 *
 * Mirrors {@link SnifferEnhancementService}: writes go through a temp-file +
 * atomic rename so a crash mid-write never leaves a truncated document, and a
 * serial queue keeps concurrent requests from interleaving. The model is
 * lazy-loaded at first use and coalesced by {@link coerceTunConfig}, so a stale
 * or hand-edited file never crashes the renderer.
 *
 * Unlike the DNS/sniffer services this model does NOT feed the main-kernel
 * profile pipeline — `tun` is dropped by the safety transform. Instead it is
 * read by the mihomo-owned adapter at enable-time and folded into the TUN
 * bootstrap profile. `get`/`set`/`preview` are the renderer window; `readConfig`
 * is the adapter-facing accessor.
 */
export class TunConfigService implements TunConfigGateway {
  private config: TunConfigModel | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly appDataBase: string) {}

  get(): Promise<TunConfigSnapshot> {
    return this.serial(async () => ({ config: { ...(await this.ensureLoaded()) } }))
  }

  set(input: TunConfigModel): Promise<TunConfigSnapshot> {
    return this.serial(async () => {
      this.config = coerceTunConfig(input)
      await this.persist()
      return { config: { ...this.config } }
    })
  }

  /** Render a YAML preview of the `tun:` block a model would produce. */
  preview(input: TunConfigModel): string {
    return stringify({ tun: { enable: true, ...buildTunBlock(coerceTunConfig(input)) } })
  }

  /** The current model, for the mihomo-owned adapter to fold into its bootstrap. */
  readConfig(): Promise<TunConfigModel> {
    return this.serial(async () => ({ ...(await this.ensureLoaded()) }))
  }

  /** Coalesced snapshot for tests / external readers that want a plain value. */
  async snapshot(): Promise<TunConfigSnapshot> {
    return coerceTunConfigSnapshot({ config: await this.readConfig() })
  }

  private async ensureLoaded(): Promise<TunConfigModel> {
    if (this.config) return this.config
    let migrated = false
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      const source = (parsed as { config?: unknown })?.config
      this.config = coerceTunConfig(source)
      // One-time default migration: 9000 was the stock default before 0.5.8
      // (written verbatim by the renderer's form initializer), not a deliberate
      // user choice. Bump it to the Ethernet-safe 1500; any other value is the
      // user's own and survives untouched. Idempotent by construction: after
      // the first persist the file no longer carries 9000.
      if (this.config.mtu === LEGACY_TUN_MTU_DEFAULT) {
        this.config = { ...this.config, mtu: EMPTY_TUN_CONFIG.mtu }
        migrated = true
      }
    } catch {
      this.config = coerceTunConfig(EMPTY_TUN_CONFIG)
    }
    if (migrated) await this.persist().catch(() => undefined)
    return this.config
  }

  private async persist(): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const snapshot: TunConfigSnapshot = { config: this.config! }
    const tmp = join(this.appDataBase, `.${TUN_CONFIG_FILE}.${Date.now()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private get filePath(): string {
    return join(this.appDataBase, TUN_CONFIG_FILE)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
