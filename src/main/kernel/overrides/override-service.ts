import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { OverrideItem, OverrideInput, OverridesSnapshot } from '@shared/overrides'
import { coerceOverrideItem, EMPTY_OVERRIDES } from '@shared/overrides'
import type { OverridesGateway } from '@shared/gateways'
import { applyOverridesToDocument } from './apply-overrides'

/** Filename of the persisted overrides document. */
export const OVERRIDES_FILE = 'overrides.json'

/**
 * Durable override store in the product-name-free app-data namespace.
 *
 * Overrides are an ordered list; `order` always equals the array index, so the
 * list itself is the application order. Reads are served from an in-memory copy
 * loaded at first use; every mutation round-trips through the serial queue and
 * is persisted via a temp-file + atomic rename, so a crash mid-write never
 * leaves a truncated document.
 */
export class OverrideService implements OverridesGateway {
  private items: OverrideItem[] | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly appDataBase: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  list(): Promise<OverridesSnapshot> {
    return this.serial(() => this.ensureLoaded().then(() => ({ items: [...this.items!] })))
  }

  create(input: OverrideInput): Promise<OverridesSnapshot> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const item: OverrideItem = {
        id: randomUUID(),
        name: input.name,
        kind: input.kind,
        enabled: true,
        scope: input.scope,
        profileId: input.scope === 'profile' ? input.profileId ?? null : null,
        order: this.items!.length,
        content: input.content,
        updatedAt: this.now()
      }
      this.items!.push(item)
      await this.persist()
      return { items: [...this.items!] }
    })
  }

  update(id: string, input: OverrideInput): Promise<OverridesSnapshot> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const index = this.items!.findIndex((item) => item.id === id)
      if (index < 0) throw new Error('覆写不存在')
      const current = this.items![index]
      this.items![index] = {
        ...current,
        name: input.name,
        kind: input.kind,
        scope: input.scope,
        profileId: input.scope === 'profile' ? input.profileId ?? null : null,
        content: input.content,
        updatedAt: this.now()
      }
      await this.persist()
      return { items: [...this.items!] }
    })
  }

  remove(id: string): Promise<OverridesSnapshot> {
    return this.serial(async () => {
      await this.ensureLoaded()
      this.items = this.reindex(this.items!.filter((item) => item.id !== id))
      await this.persist()
      return { items: [...this.items!] }
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<OverridesSnapshot> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const index = this.items!.findIndex((item) => item.id === id)
      if (index < 0) throw new Error('覆写不存在')
      this.items![index] = { ...this.items![index], enabled, updatedAt: this.now() }
      await this.persist()
      return { items: [...this.items!] }
    })
  }

  move(id: string, direction: 'up' | 'down'): Promise<OverridesSnapshot> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const index = this.items!.findIndex((item) => item.id === id)
      if (index < 0) throw new Error('覆写不存在')
      const target = direction === 'up' ? index - 1 : index + 1
      if (target < 0 || target >= this.items!.length) return { items: [...this.items!] }
      const next = [...this.items!]
      ;[next[index], next[target]] = [next[target], next[index]]
      this.items = this.reindex(next)
      await this.persist()
      return { items: [...this.items!] }
    })
  }

  /**
   * Apply the effective overrides for a profile onto its base document and
   * return the resulting YAML text. Used by the kernel config pipeline's
   * `resolveActiveDocument` at start time. Dangerous or invalid overrides fail
   * open at the per-item level (see {@link applyOverridesToDocument}).
   */
  async applyForProfile(baseDocument: string, profileId: string | null): Promise<string> {
    await this.ensureLoaded()
    const effective = this.effectiveOverrides(profileId ?? null)
    return applyOverridesToDocument(baseDocument, effective).text
  }

  /** Enabled overrides that apply to a profile: global ones plus its own scoped ones. */
  effectiveOverrides(profileId: string | null): OverrideItem[] {
    const items = (this.items ?? []).filter(
      (item) =>
        item.enabled &&
        (item.scope === 'global' || (item.scope === 'profile' && item.profileId === profileId))
    )
    return [...items].sort((a, b) => a.order - b.order)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.items) return
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      const source = (parsed as { items?: unknown })?.items
      const items = Array.isArray(source) ? source.map(coerceOverrideItem) : []
      this.items = this.reindex(items)
    } catch {
      this.items = []
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const snapshot: OverridesSnapshot = { items: this.items! }
    const tmp = join(this.appDataBase, `.${OVERRIDES_FILE}.${randomUUID()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private reindex(items: OverrideItem[]): OverrideItem[] {
    return items.map((item, index) => (item.order === index ? item : { ...item, order: index }))
  }

  private get filePath(): string {
    return join(this.appDataBase, OVERRIDES_FILE)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
