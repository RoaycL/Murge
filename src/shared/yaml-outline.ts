import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument } from 'yaml'

/** One top-level key of a config document, for the editor's outline. */
export interface YamlSection {
  key: string
  /** 1-based line of the key. */
  line: number
  kind: 'list' | 'map' | 'value'
  /** Item count for lists and maps; undefined for plain values. */
  count?: number
  /** Short preview of a plain value (`7890`, `rule`). */
  value?: string
}

export interface YamlProblem {
  /** 1-based line, 0 when the parser gave no position. */
  line: number
  col: number
  message: string
  severity: 'error' | 'warning'
}

export interface YamlAnalysis {
  lines: number
  sections: YamlSection[]
  problems: YamlProblem[]
}

/**
 * Parses a config document for the profile editor: the top-level sections
 * (proxies, proxy-groups, rules …) with their sizes, and any syntax errors
 * with line numbers. Never throws.
 */
export function analyzeYaml(source: string): YamlAnalysis {
  const lineCounter = new LineCounter()
  const lines = source === '' ? 1 : source.split('\n').length
  const sections: YamlSection[] = []
  const problems: YamlProblem[] = []
  let doc
  try {
    doc = parseDocument(source, { lineCounter, prettyErrors: false, uniqueKeys: false })
  } catch (error) {
    return { lines, sections, problems: [{ line: 0, col: 0, message: error instanceof Error ? error.message : String(error), severity: 'error' }] }
  }
  const position = (offset: number | undefined) => (typeof offset === 'number' ? lineCounter.linePos(offset) : { line: 0, col: 0 })
  for (const [list, severity] of [[doc.errors, 'error'], [doc.warnings, 'warning']] as const) {
    for (const issue of list) {
      const { line, col } = position(issue.pos?.[0])
      problems.push({ line, col, message: firstLine(issue.message), severity })
    }
  }
  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      if (!isPair(item)) continue
      const key = isScalar(item.key) ? String(item.key.value) : String(item.key ?? '')
      const range = isScalar(item.key) ? item.key.range : undefined
      const line = position(range?.[0]).line
      if (isSeq(item.value)) sections.push({ key, line, kind: 'list', count: item.value.items.length })
      else if (isMap(item.value)) sections.push({ key, line, kind: 'map', count: item.value.items.length })
      else {
        const raw = isScalar(item.value) && item.value.value !== null ? String(item.value.value) : ''
        sections.push({ key, line, kind: 'value', ...(raw ? { value: raw.length > 24 ? `${raw.slice(0, 23)}…` : raw } : {}) })
      }
    }
  }
  return { lines, sections, problems }
}

function firstLine(message: string): string {
  return message.split('\n')[0].trim()
}

const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function esc(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => escapeMap[ch])
}
function span(cls: string, text: string): string {
  return text ? `<span class="yt-${cls}">${esc(text)}</span>` : ''
}

/** Index of a `#` that starts a comment (outside quotes, after whitespace or at start). */
function commentStart(line: string): number {
  let quote: string | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      // Quotes only open a string at a token boundary.
      if (i === 0 || /[\s:,[{-]/.test(line[i - 1])) quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return i
    }
  }
  return -1
}

/** Index of the `:` that ends a mapping key, or -1. */
function keyEnd(text: string): number {
  if (/^["']/.test(text)) {
    const q = text[0]
    let i = 1
    while (i < text.length && text[i] !== q) i += text[i] === '\\' && q === '"' ? 2 : 1
    return text[i + 1] === ':' && (i + 2 === text.length || /\s/.test(text[i + 2])) ? i + 1 : -1
  }
  if (/^[[{]/.test(text)) return -1
  const match = /:(?=\s|$)/.exec(text)
  return match ? match.index : -1
}

function highlightValue(text: string): string {
  const trimmed = text.trimEnd()
  const trailing = text.slice(trimmed.length)
  const lead = /^\s*/.exec(trimmed)![0]
  const value = trimmed.slice(lead.length)
  if (!value) return esc(text)
  let cls = 'str'
  if (/^(?:true|false|yes|no|on|off|null|~)$/i.test(value)) cls = 'bool'
  else if (/^[-+]?(?:\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?|0x[\da-f]+|\.inf|\.nan)$/i.test(value)) cls = 'num'
  else if (/^[&*][^\s]+$/.test(value)) cls = 'anchor'
  else if (/^![^\s]*/.test(value)) cls = 'tag'
  else if (/^[|>][-+0-9]*$/.test(value)) cls = 'punct'
  else if (/^[[{]/.test(value)) return lead + highlightFlow(value) + trailing
  return esc(lead) + span(cls, value) + esc(trailing)
}

function highlightFlow(text: string): string {
  // Flow collections: colour punctuation and quoted strings, keep the rest plain.
  let out = ''
  const re = /("(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?|[[\]{},]|[^"'[\]{},]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const token = match[0]
    if (/^["']/.test(token)) out += span('str', token)
    else if (/^[[\]{},]$/.test(token)) out += span('punct', token)
    else {
      const colon = /^(\s*)([^:]+?)(\s*:)(?=\s|$)(.*)$/.exec(token)
      if (colon) out += esc(colon[1]) + span('key', colon[2]) + span('punct', colon[3]) + highlightValue(colon[4])
      else out += highlightValue(token)
    }
  }
  return out
}

/** Escaped HTML for one line of YAML, with `yt-*` token classes. */
export function highlightYamlLine(line: string): string {
  if (/^(?:---|\.\.\.)\s*$/.test(line)) return span('punct', line)
  if (/^%/.test(line)) return span('comment', line)
  const hash = commentStart(line)
  const code = hash >= 0 ? line.slice(0, hash) : line
  const comment = hash >= 0 ? line.slice(hash) : ''
  let out = ''
  let rest = code
  const indent = /^\s*/.exec(rest)![0]
  out += indent
  rest = rest.slice(indent.length)
  // Sequence dashes, possibly nested ("- - a").
  let dash: RegExpExecArray | null
  while ((dash = /^-(?=\s|$)\s*/.exec(rest))) {
    out += span('punct', dash[0])
    rest = rest.slice(dash[0].length)
  }
  const end = keyEnd(rest)
  if (end >= 0) {
    out += span('key', rest.slice(0, end)) + span('punct', ':')
    rest = rest.slice(end + 1)
  }
  out += highlightValue(rest)
  return out + span('comment', comment)
}
