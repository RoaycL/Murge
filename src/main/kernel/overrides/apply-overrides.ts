import { parseDocument, stringify, isMap } from 'yaml'
import { createContext, runInContext } from 'node:vm'
import type { OverrideItem } from '@shared/overrides'

/**
 * Pure, side-effect-free application of override items to a profile document.
 *
 * The pipeline is: parse the base document into a JS object → apply each enabled
 * override in `order` → re-serialize. Every step is fail-open at the per-item
 * level: a malformed YAML override or a throwing JS override leaves the current
 * config intact and adds a warning, so one bad override can never break the
 * kernel start. The caller re-validates the result through the strict
 * profile-config safety pass afterwards, so even the runtime copy keeps the
 * loopback-only invariant.
 */

export interface ApplyOverridesResult {
  /** The transformed mihomo config document (YAML). */
  text: string
  /** Non-fatal diagnostics for the caller to surface or log. */
  warnings: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    !(value instanceof Date) && !(value instanceof Map)
}

/** Combine array leaves, deduplicating by stringified value. */
function mergeList(base: unknown, next: unknown, mode: 'append' | 'prepend'): unknown {
  const lhs = Array.isArray(base) ? base : []
  const rhs = Array.isArray(next) ? next : []
  const seen = new Set<string>()
  const out: unknown[] = []
  const push = (value: unknown): void => {
    const key = JSON.stringify(value)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(value)
    }
  }
  if (mode === 'prepend') {
    for (const value of rhs) push(value)
    for (const value of lhs) push(value)
  } else {
    for (const value of lhs) push(value)
    for (const value of rhs) push(value)
  }
  return out
}

/**
 * Deep-merge a YAML override object into the base config.
 *
 * Plain objects merge recursively; arrays and scalars replace unless the key
 * uses the `+key` (prepend) or `key+` (append) modifier, in which case the
 * base list is combined with the override list. The modifier name is always
 * written back as the clean `key`, so a `+rules` in the override becomes
 * `rules` in the runtime config.
 */
export function mergeOverrideObject(base: Record<string, unknown>, override: Record<string, unknown>): void {
  for (const [rawKey, value] of Object.entries(override)) {
    let key = rawKey
    let mode: 'append' | 'prepend' | null = null
    if (key.endsWith('+')) {
      key = key.slice(0, -1)
      mode = 'append'
    } else if (key.startsWith('+')) {
      key = key.slice(1)
      mode = 'prepend'
    }

    if (mode) {
      base[key] = mergeList(base[key], value, mode)
      continue
    }

    const baseValue = base[key]
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      mergeOverrideObject(baseValue, value)
    } else {
      base[key] = value
    }
  }
}

export function parseYamlToObject(text: string): Record<string, unknown> | null {
  try {
    const doc = parseDocument(text, { merge: true, uniqueKeys: true })
    if (doc.errors.length > 0) return null
    if (!isMap(doc.contents)) return null
    const data = doc.toJS()
    if (!isPlainObject(data)) return null
    return data
  } catch {
    return null
  }
}

/**
 * Run a JS override in a sealed VM sandbox and return the resulting config.
 *
 * The sandbox exposes only a shadow `console`; no `require`, `process`, `fs` or
 * other Node globals are reachable, and the script is bounded by a hard timeout
 * so a runaway loop cannot stall the main process. `main(config)` may mutate the
 * shared config object and/or return a new one.
 */
export function runJsOverride(content: string, config: Record<string, unknown>): { next: Record<string, unknown>; warnings: string[] } {
  const messages: string[] = []
  const consoleShadow: Record<string, (...args: unknown[]) => void> = {
    log: (...args) => messages.push(args.map(String).join(' ')),
    info: (...args) => messages.push(args.map(String).join(' ')),
    warn: (...args) => messages.push(`warn: ${args.map(String).join(' ')}`),
    error: (...args) => messages.push(`error: ${args.map(String).join(' ')}`),
    debug: (...args) => messages.push(args.map(String).join(' '))
  }
  const sandbox: Record<string, unknown> = { console: consoleShadow }
  const context = createContext(sandbox)
  const warnings: string[] = []

  // (1) Define `main` (and any helpers) from the user's body.
  try {
    runInContext(content, context, { timeout: 2000 })
  } catch (error) {
    warnings.push(`JS 覆写脚本执行失败：${(error as Error).message.split('\n')[0]}`)
    return { next: config, warnings: [...warnings, ...messages] }
  }

  // (2) Invoke main(config) with the shared base config reference.
  sandbox.config = config
  try {
    runInContext('(typeof main === "function") ? (globalThis.__overrideResult = main(config)) : null', context, { timeout: 2000 })
  } catch (error) {
    warnings.push(`JS 覆写 main(config) 执行失败：${(error as Error).message.split('\n')[0]}`)
  }

  const returned = sandbox.__overrideResult as unknown
  delete sandbox.__overrideResult

  // `main` may have mutated `config` in place; a returned object also wins.
  let next = config
  if (isPlainObject(returned)) next = returned
  return { next, warnings: [...warnings, ...messages] }
}

/**
 * Apply every enabled override (already selected & ordered by the caller) to a
 * base profile document. With no runnable overrides the base text is returned
 * verbatim (zero copying, no re-serialization churn).
 */
export function applyOverridesToDocument(base: string, items: OverrideItem[]): ApplyOverridesResult {
  const runnable = items.filter((item) => item.enabled && item.content.trim().length > 0)
  if (runnable.length === 0) return { text: base, warnings: [] }

  let config = parseYamlToObject(base)
  if (!config) {
    // Base is unparseable — leave it verbatim and let the validator reject it.
    return { text: base, warnings: ['基础配置文件无法解析，已跳过全部覆写'] }
  }

  const warnings: string[] = []
  const ordered = [...runnable].sort((a, b) => a.order - b.order)
  for (const item of ordered) {
    if (item.kind === 'yaml') {
      const override = parseYamlToObject(item.content)
      if (!override) {
        warnings.push(`覆写「${item.name}」YAML 解析失败，已跳过`)
        continue
      }
      mergeOverrideObject(config, override)
    } else {
      const result = runJsOverride(item.content, config)
      config = result.next
      warnings.push(...result.warnings.map((message) => `覆写「${item.name}」：${message}`))
    }
  }

  return { text: stringify(config), warnings }
}
