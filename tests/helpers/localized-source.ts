/**
 * The UI-contract tests assert on the wording a view ships. Views now carry
 * message keys (`t('about.title')`), so this puts the zh-CN source text back
 * in place of each call before the assertions run: `{{ t('k') }}` becomes the
 * text, `:title="t('k')"` becomes `title="…"`, and `t('k', [a])` becomes a
 * template literal (or `{{ a }}` interpolations inside a text node). Getter
 * properties (`get label() { return t('k') }`) read as `label: '…'`.
 */
import zhCN from '../../src/shared/i18n/locales/zh-CN.json'

const MESSAGES: Record<string, string> = zhCN

interface Call { end: number; key: string; params: string[] }

/** Parse `t('key')` / `t('key', [a, b])` starting at `start` (the `t`). */
function parseCall(source: string, start: number): Call | null {
  const head = /^t\('([\w.]+)'/.exec(source.slice(start, start + 120))
  if (!head) return null
  let at = start + head[0].length
  const params: string[] = []
  if (source[at] === ')') return { end: at + 1, key: head[1], params }
  if (source.slice(at, at + 3) !== ', [') return null
  at += 3
  let depth = 0
  let quote = ''
  let current = ''
  for (; at < source.length; at++) {
    const char = source[at]
    if (quote) {
      current += char
      if (char === '\\') current += source[++at]
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; current += char; continue }
    if (char === '(' || char === '[' || char === '{') depth++
    if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break
      depth--
    }
    if (char === ',' && depth === 0) { params.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim()) params.push(current.trim())
  if (source.slice(at, at + 2) !== '])') return null
  return { end: at + 2, key: head[1], params }
}

export function inlineMessages(input: string): string {
  let source = input
  // Innermost calls first, so a call used as a parameter is already text.
  for (let pass = 0; pass < 4; pass++) {
    let out = ''
    let at = 0
    let changed = false
    const pattern = /(?<![\w.$])t\('/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) {
      const call = parseCall(source, match.index)
      if (!call || MESSAGES[call.key] === undefined) continue
      if (call.params.some((param) => /(?<![\w.$])t\('/.test(param))) continue
      const message = MESSAGES[call.key]
      const before = source.slice(at, match.index)
      const after = source.slice(call.end)
      const fill = (wrap: (param: string) => string): string => message.replace(/\{(\d+)\}/g, (_, index: string) => wrap(call.params[Number(index)] ?? ''))
      const attribute = /(\s):([\w-]+)="$/.exec(before)
      if (attribute && after.startsWith('"') && call.params.length === 0) {
        out += before.slice(0, attribute.index) + `${attribute[1]}${attribute[2]}="${message}`
      } else if (/\{\{ $/.test(before) && after.startsWith(' }}')) {
        out += before.slice(0, -3) + fill((param) => `{{ ${param} }}`)
        at = call.end + 3
        pattern.lastIndex = at
        changed = true
        continue
      } else if (call.params.length === 0) {
        out += before + `'${message.replace(/\n/g, '\\n')}'`
      } else {
        out += before + '`' + fill((param) => '${' + param + '}') + '`'
      }
      at = call.end
      pattern.lastIndex = at
      changed = true
    }
    source = out + source.slice(at)
    if (!changed) break
  }
  // Module-level tables read their labels through getters.
  return source.replace(/get ('[^']+'|[\w$]+)\(\) \{ return ('(?:[^'\\]|\\.)*'|`[^`]*`) \}/g, '$1: $2')
}
