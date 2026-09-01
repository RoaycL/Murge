import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  OverrideItem,
  OverrideInput,
  OverridesSnapshot,
  OverridePreview,
  OverrideValidation,
  OverrideValidationIssue,
  OverrideLastKnownGood
} from '@shared/overrides'
import { coerceOverrideItem, redactOverrideContent } from '@shared/overrides'
import type { OverridesGateway } from '@shared/gateways'
import { applyOverridesToDocument, validateOverrideContent } from './apply-overrides'
import { profileKernelConfigErrors } from '../profile-kernel-config'

/** Filename of the persisted overrides document. */
export const OVERRIDES_FILE = 'overrides.json'

/** Resolves the base profile document an override set is previewed/validated against. */
export type ResolveOverrideBaseDocument = () => Promise<{ document: string; profileId: string | null } | null>

/**
 * Durable override store in the product-name-free app-data namespace.
 *
 * Overrides are an ordered list; `order` always equals the array index, so the
 * list itself is the application order. Reads are served from an in-memory copy
 * loaded at first use; every mutation round-trips through the serial queue and
 * is persisted via a temp-file + atomic rename, so a crash mid-write never
 * leaves a truncated document.
 *
 * Extends the CRUD surface with the #411 "预演/校验/回滚" capability: a redacted
 * preview ({@link OverrideService.preview}), a structural + semantic validation
 * ({@link OverrideService.validate}), and a last-known-good snapshot with a
 * rollback ({@link OverrideService.lastKnownGood} / {@link OverrideService.resetToLastGood}).
 * The last-known-good state is captured whenever the effective override set
 * produces a structurally valid runtime config, so a bad edit can be undone.
 */
export class OverrideService implements OverridesGateway {
  private items: OverrideItem[] | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private lastGood: OverrideLastKnownGood | null = null

  constructor(
    private readonly appDataBase: string,
    private readonly now: () => number = () => Date.now(),
    private readonly resolveBaseDocument?: ResolveOverrideBaseDocument,
    private readonly structureErrors: (text: string) => string[] = profileKernelConfigErrors
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
   *
   * When the result is structurally valid it is recorded as the last-known-good
   * override set for a later rollback.
   */
  async applyForProfile(baseDocument: string, profileId: string | null): Promise<string> {
    await this.ensureLoaded()
    const effective = this.effectiveOverrides(profileId ?? null)
    const result = applyOverridesToDocument(baseDocument, effective)
    this.maybeCaptureLastGood(result.text)
    return result.text
  }

  /**
   * Produce a redacted preview of what the effective override set does to the
   * active profile document, together with a line diff-able pair of texts and
   * any non-fatal apply warnings. Secrets, credentials and URL user-info are
   * masked in both texts so nothing sensitive reaches the renderer.
   */
  async preview(): Promise<OverridePreview> {
    await this.ensureLoaded()
    const base = await this.resolveBaseDocument?.() ?? null
    if (!base) {
      return { baseText: '', appliedText: '', warnings: ['当前没有活动的订阅，无法预演覆写'], unavailable: true }
    }
    const effective = this.effectiveOverrides(base.profileId)
    const result = applyOverridesToDocument(base.document, effective)
    return {
      baseText: redactOverrideContent(base.document),
      appliedText: redactOverrideContent(result.text),
      warnings: result.warnings,
      unavailable: false
    }
  }

  /**
   * Validate the *effective* override set for the active profile: per-item
   * structural checks (YAML parses to a map, JS defines `main`) plus a semantics
   * check that the merged result does not break a previously-valid base config.
   * A structurally valid result is recorded as the last-known-good state.
   */
  async validate(): Promise<OverrideValidation> {
    await this.ensureLoaded()
    const base = await this.resolveBaseDocument?.() ?? null
    const issues: OverrideValidationIssue[] = []
    if (!base) {
      issues.push({ itemName: null, level: 'error', message: '当前没有活动的订阅，无法校验覆写' })
      return { valid: false, issues }
    }

    const effective = this.effectiveOverrides(base.profileId)
    const active = effective.filter((item) => item.enabled && item.content.trim().length > 0)

    // Per-item structural checks.
    for (const item of active) {
      const issue = validateOverrideContent(item)
      if (issue) issues.push({ itemName: item.name, level: 'error', message: issue })
    }
    if (active.length === 0) {
      issues.push({ itemName: null, level: 'warning', message: '当前没有启用的覆写，将原样使用订阅配置' })
    }

    // Whole-chain semantic check: overrides must not break a valid base.
    const appliedText = applyOverridesToDocument(base.document, effective).text
    const baseErrors = this.structureErrors(base.document)
    const appliedErrors = this.structureErrors(appliedText)
    const introduced = appliedErrors.filter((error) => !baseErrors.includes(error))
    if (introduced.length > 0) {
      issues.push({ itemName: null, level: 'error', message: `覆写使运行时配置失效：${introduced.join('；')}` })
    } else if (baseErrors.length > 0) {
      issues.push({ itemName: null, level: 'warning', message: '基础配置本身存在结构问题（与覆写无关）' })
    }

    const valid = !issues.some((issue) => issue.level === 'error')
    if (valid) this.maybeCaptureLastGood(appliedText)
    return { valid, issues }
  }

  /** The last-known-good override snapshot, if one has been captured. */
  lastKnownGood(): Promise<OverrideLastKnownGood | null> {
    return this.serial(async () => {
      await this.ensureLoaded()
      if (!this.lastGood) return null
      return {
        capturedAt: this.lastGood.capturedAt,
        snapshot: this.lastGood.snapshot.map((item) => ({ ...item }))
      }
    })
  }

  /** Restore the override list to its last-known-good state, if one exists. */
  resetToLastGood(): Promise<OverridesSnapshot> {
    return this.serial(async () => {
      await this.ensureLoaded()
      if (!this.lastGood) return { items: [...this.items!] }
      this.items = this.reindex(this.lastGood.snapshot.map((item) => ({ ...item })))
      await this.persist()
      return { items: [...this.items!] }
    })
  }

  /** Capture the current override list as last-known-good when the applied config is valid. */
  private maybeCaptureLastGood(appliedText: string): void {
    if (this.structureErrors(appliedText).length === 0) {
      this.lastGood = { capturedAt: this.now(), snapshot: [...this.items!] }
    }
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
