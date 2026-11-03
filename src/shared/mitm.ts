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
    hostnames: string[]
    localModule: string
  }
  modules: MitmModuleInfo[]
  localWarnings: string[]
  ca: MitmCaInfo | null
  trustSupported: boolean
  engine: { running: boolean; port: number | null }
  active: boolean
  inactiveReason: string | null
  summary: {
    hostnames: string[]
    urlRewrites: number
    headerRewrites: number
    bodyRewrites: number
    mapLocals: number
    /** Module [Rule] lines handed to Mihomo. */
    rules: number
  }
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
}

export const EMPTY_MITM_STATE: MitmState = {
  settings: { enabled: false, rewriteEnabled: true, skipServerCertVerify: false, http2: true, hostnames: [], localModule: '' },
  modules: [],
  localWarnings: [],
  ca: null,
  trustSupported: false,
  engine: { running: false, port: null },
  active: false,
  inactiveReason: null,
  summary: { hostnames: [], urlRewrites: 0, headerRewrites: 0, bodyRewrites: 0, mapLocals: 0, rules: 0 }
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
