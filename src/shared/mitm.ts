/**
 * HTTPS 解密 + 重写 (docs/MITM_REWRITE.md). The Rust service owns the state;
 * these are the renderer-facing snapshot shapes of the `mitm:*` channels.
 */

export interface MitmCaInfo {
  commonName: string
  /** SHA-256, colon-separated uppercase hex. */
  fingerprint: string
  /** Epoch milliseconds. */
  notBefore: number
  notAfter: number
  /** null when this platform cannot tell. */
  trusted: boolean | null
}

export interface MitmModuleInfo {
  id: string
  name: string
  description: string
  url: string | null
  enabled: boolean
  updatedAt: number
  error: string | null
  ruleCount: number
  hostnames: string[]
  warnings: string[]
  /** `#!arguments` declared by the module, with the user's current value. */
  arguments: MitmModuleArgument[]
  /** The module's `#!arguments-desc` text (may be empty). */
  argumentsDesc: string
  /** `[Script]` entries (http-request / http-response). */
  scripts: number
  /** The module's raw text (shown in the module viewer). */
  content?: string
}

/** A module text split into its `#!` metadata and `[Section]` bodies, for display. */
export function moduleSections(text: string): { meta: Record<string, string>; sections: Array<{ name: string; body: string }> } {
  const meta: Record<string, string> = {}
  const sections: Array<{ name: string; body: string }> = []
  let current: { name: string; lines: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    const body = current.lines.join('\n').trim()
    if (body) sections.push({ name: current.name, body })
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const header = SECTION_HEADER.exec(line)
    if (header) {
      flush()
      current = { name: header[1].trim(), lines: [] }
      continue
    }
    if (!current) {
      const metaLine = /^#!([\w-]+)\s*=\s*(.*)$/.exec(line.trim())
      if (metaLine) meta[metaLine[1]] = metaLine[2]
      continue
    }
    // Comments stay out of the viewer, like Surge's module sheet.
    if (/^\s*(#|;|\/\/)/.test(line)) continue
    current.lines.push(line)
  }
  flush()
  return { meta, sections }
}

export interface MitmModuleArgument {
  name: string
  default: string
  value: string
}

export interface MitmState {
  settings: {
    enabled: boolean
    rewriteEnabled: boolean
    skipServerCertVerify: boolean
    http2: boolean
    blockQuic: boolean
    hostnames: string[]
    disabledHostnames: string[]
    localModule: string
  }
  modules: MitmModuleInfo[]
  localWarnings: string[]
  ca: MitmCaInfo | null
  trustSupported: boolean
  engine: { running: boolean; port: number | null }
  active: boolean
  inactiveReason: string | null
  /** Every active rule per section ([URL Rewrite] …), with where it came from. */
  activeRules?: Record<string, MitmActiveRule[]>
  summary: {
    hostnames: string[]
    urlRewrites: number
    headerRewrites: number
    bodyRewrites: number
    mapLocals: number
    /** Module [Rule] lines handed to Mihomo. */
    rules: number
    /** Scripts downloaded and active. */
    scripts: number
    /** Keys held in the scripts' $persistentStore. */
    scriptStoreKeys: number
  }
}

export interface MitmActiveRule {
  /** Surge-style one-line form of the rule. */
  text: string
  /** 「本地」 or the module's name. */
  source: string
}

export interface MitmRequestEntry {
  id: number
  time: number
  method: string
  url: string
  host: string
  status: number | null
  actions: string[]
  durationMs: number
  error: string | null
  /** console.log output of the scripts that ran. */
  scriptLogs: string[]
}

export const EMPTY_MITM_STATE: MitmState = {
  settings: { enabled: false, rewriteEnabled: true, skipServerCertVerify: false, http2: true, blockQuic: true, hostnames: [], disabledHostnames: [], localModule: '' },
  modules: [],
  localWarnings: [],
  ca: null,
  trustSupported: false,
  engine: { running: false, port: null },
  active: false,
  inactiveReason: null,
  summary: { hostnames: [], urlRewrites: 0, headerRewrites: 0, bodyRewrites: 0, mapLocals: 0, rules: 0, scripts: 0, scriptStoreKeys: 0 }
}

/** Human labels for the pipeline actions recorded per request. */
export const MITM_ACTION_LABELS: Record<string, string> = {
  '301': '301 重定向',
  '302': '302 重定向',
  '307': '307 重定向',
  '308': '308 重定向',
  reject: '拒绝',
  'reject-200': '拒绝 (200)',
  'reject-img': '拒绝 (图片)',
  'reject-dict': '拒绝 ({})',
  'reject-array': '拒绝 ([])',
  header: 'URL 改写',
  'map-local': '本地映射',
  'header-rewrite': '改写请求头/响应头',
  'body-rewrite': '改写正文',
  websocket: 'WebSocket'
}

/** Label for one recorded action, including per-script ones (`script:名字`). */
export function mitmActionLabel(action: string): string {
  if (action.startsWith('script:')) return `脚本 ${action.slice(7)}`
  if (action.startsWith('script-pass:')) return `脚本 ${action.slice(12)}（未修改）`
  if (action.startsWith('script-error:')) return `脚本 ${action.slice(13)} 出错`
  return MITM_ACTION_LABELS[action] ?? action
}

const SECTION_HEADER = /^\s*\[([^\]]+)\]\s*$/

/** The body of every `[name]` section of a module text (case-insensitive), joined. */
export function moduleSection(text: string, name: string): string {
  const wanted = name.toLowerCase()
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    const header = SECTION_HEADER.exec(line)
    if (header) {
      current = header[1].trim().toLowerCase() === wanted ? [] : null
      if (current) blocks.push(current)
      continue
    }
    current?.push(line)
  }
  return blocks
    .map((block) => block.join('\n').trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Replace the `[name]` section(s) of a module text with `body`. The first
 * occurrence keeps its place, later duplicates are dropped, and a missing
 * section is appended. An empty body removes the section.
 */
export function replaceModuleSection(text: string, name: string, body: string): string {
  const wanted = name.toLowerCase()
  const lines = text ? text.split(/\r?\n/) : []
  const bodyLines = body.split(/\r?\n/)
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop()
  const replacement = bodyLines.length ? [`[${name}]`, ...bodyLines, ''] : []
  const out: string[] = []
  let inside = false
  let placed = false
  for (const line of lines) {
    const header = SECTION_HEADER.exec(line)
    if (header) {
      inside = header[1].trim().toLowerCase() === wanted
      if (inside) {
        if (!placed) out.push(...replacement)
        placed = true
        continue
      }
    }
    if (!inside) out.push(line)
  }
  if (!placed && replacement.length) {
    while (out.length && !out[out.length - 1].trim()) out.pop()
    if (out.length) out.push('')
    out.push(...replacement)
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.length ? `${out.join('\n')}\n` : ''
}
