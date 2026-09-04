import { LineCounter, parseDocument } from 'yaml'
import type { ValidationIssue, ValidationResult } from '../../shared/profiles'

/**
 * Validation boundary for config documents.
 *
 * The real implementation (a later milestone) shells out to `mihomo -t` on the
 * host. On this development build we ship a deterministic, dependency-free
 * structural validator so the renderer and tests can exercise the same
 * accept/reject contract without a real binary, real config, or system changes.
 */
export interface ConfigValidator {
  validate(document: string): ValidationResult
}

export interface FakeValidatorOptions {
  /** When true, require a `proxies` or `proxy-groups` top-level key. */
  requireProxySections?: boolean
}

/**
 * Structural fake validator. It intentionally does NOT fully parse YAML; it
 * rejects the malformation classes that are cheap and unambiguous to detect
 * (empty documents, tab indentation, and unbalanced flow collections) and
 * optionally requires a proxy section. Full mihomo semantics arrive with the
 * real `-t` validator.
 */
export class FakeConfigValidator implements ConfigValidator {
  constructor(private readonly options: FakeValidatorOptions = {}) {}

  validate(document: string): ValidationResult {
    const issues: ValidationIssue[] = []

    if (document.trim().length === 0) {
      issues.push({ severity: 'error', message: '配置文档为空', line: 1 })
      return { ok: false, issues }
    }

    // The runtime kernel config parses with `uniqueKeys: true`, so a document
    // with a duplicated top-level key can pass import validation yet still fail
    // to start (the kernel rejects it during reload and rolls back). Gate the
    // same duplicate-key failure here so "import succeeds, activate succeeds,
    // but it never boots" cannot happen.
    const duplicateKeyIssues = findDuplicateTopLevelKeys(document)
    for (const { key, line } of duplicateKeyIssues) {
      issues.push({ severity: 'error', message: `重复的顶层键：${key}`, line })
    }

    const tabIndent = findTabIndent(document)
    if (tabIndent !== -1) {
      issues.push({ severity: 'error', message: 'YAML 不允许使用制表符缩进', line: tabIndent + 1 })
    }

    const flowError = findUnbalancedFlow(document)
    if (flowError) {
      issues.push({ severity: 'error', message: flowError.message, line: flowError.line })
    }

    const topLevel = findTopLevelKeys(document)
    if (topLevel.length === 0) {
      issues.push({ severity: 'error', message: '文档缺少顶层键' })
    }

    if (this.options.requireProxySections) {
      const hasProxy = topLevel.some((key) => key === 'proxies' || key === 'proxy-groups')
      if (!hasProxy) {
        issues.push({ severity: 'error', message: '文档缺少 proxies 或 proxy-groups 段' })
      }
    }

    return { ok: issues.length === 0, issues }
  }
}

/** Create the active validator for this build (fake on the development Mac). */
export function createConfigValidator(options?: FakeValidatorOptions): ConfigValidator {
  return new FakeConfigValidator(options)
}

function findTabIndent(document: string): number {
  const lines = document.split('\n')
  return lines.findIndex((line) => /^\t/.test(line) || /^\s+\t/.test(line))
}

/**
 * Detect duplicated top-level mapping keys using the `yaml` parser's own
 * duplicate-key tracking (same engine the kernel config gate uses), so the two
 * gates agree on what a "duplicate" is. Returns each repeated key and its
 * 1-based line. A document that does not parse is left to the other checks (and
 * the kernel's own parse error) rather than being duplicated here.
 */
function findDuplicateTopLevelKeys(document: string): Array<{ key: string; line: number }> {
  const lineCounter = new LineCounter()
  const doc = parseDocument(document, { uniqueKeys: true, merge: true, lineCounter })
  const result: Array<{ key: string; line: number }> = []
  if (!doc.contents || typeof doc.contents !== 'object' || !('items' in doc.contents)) return result
  const seen = new Set<string>()
  for (const item of doc.contents.items as Array<{ key?: unknown }>) {
    const keyNode = item?.key as { value?: unknown; range?: [number, number, number] } | undefined
    if (keyNode && typeof keyNode.value === 'string' && typeof keyNode.range?.[0] === 'number') {
      if (seen.has(keyNode.value)) {
        result.push({ key: keyNode.value, line: lineCounter.linePos(keyNode.range[0]).line })
      }
      seen.add(keyNode.value)
    }
  }
  return result
}

function findTopLevelKeys(document: string): string[] {
  const keys: string[] = []
  for (const line of document.split('\n')) {
    if (line.startsWith('#')) continue
    const trimmed = line
    const match = /^([A-Za-z0-9_.-]+)\s*:(\s|$)/.exec(trimmed)
    if (match && line[0] !== ' ' && line[0] !== '\t') keys.push(match[1] as string)
  }
  return keys
}

function findUnbalancedFlow(
  document: string
): { message: string; line: number } | null {
  let square = 0
  let curly = 0
  let inSingle = false
  let inDouble = false
  const lines = document.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (let j = 0; j < line.length; j += 1) {
      const char = line[j]
      if (char === "'" && !inDouble) inSingle = !inSingle
      else if (char === '"' && !inSingle) inDouble = !inDouble
      else if (!inSingle && !inDouble) {
        if (char === '[') square += 1
        else if (char === ']') square -= 1
        else if (char === '{') curly += 1
        else if (char === '}') curly -= 1
      }
      if (square < 0 || curly < 0) {
        return { message: '存在未闭合的方括号或花括号', line: i + 1 }
      }
    }
  }
  if (square !== 0 || curly !== 0) {
    return { message: '存在未闭合的方括号或花括号', line: lines.length }
  }
  return null
}
