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
