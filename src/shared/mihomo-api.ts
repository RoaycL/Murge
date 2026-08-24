export interface MihomoVersion {
  meta: boolean
  version: string
}

export interface DelayHistory {
  time: string
  delay: number
  [key: string]: unknown
}

export interface MihomoProxy {
  name: string
  type: string
  udp?: boolean
  alive?: boolean
  history?: DelayHistory[]
  now?: string
  all?: string[]
  hidden?: boolean
  icon?: string
  testUrl?: string
  fixed?: string
  [key: string]: unknown
}

export interface MihomoProxiesResponse {
  proxies: Record<string, MihomoProxy>
}

export interface MihomoRule {
  index: number
  type: string
  payload: string
  proxy: string
  size: number
  extra?: {
    disabled?: boolean
    hitCount?: number
    hitAt?: string
    missCount?: number
    missAt?: string
  }
  [key: string]: unknown
}

export interface MihomoRulesResponse {
  rules: MihomoRule[]
}

export interface MihomoProxyProvider {
  name: string
  type: string
  /** `HTTP`/`Compatible`/`File`/`local` vehicle for a proxy provider. */
  vehicleType?: string
  /** Grouping behavior: `rule`, `global`, `direct`. */
  behavior?: string
  /** Member proxy names resolved from this provider. */
  proxies?: string[]
  proxiesCount?: number
  /** Provider health/version stamp; may be an empty object when not loaded. */
  now?: string | Record<string, unknown> | null
  updatedAt?: string
  [key: string]: unknown
}

export interface MihomoProxyProvidersResponse {
  providers: Record<string, MihomoProxyProvider>
}

export interface MihomoRuleProvider {
  name: string
  type: string
  behavior?: string
  ruleCount?: number
  now?: string | Record<string, unknown> | null
  updatedAt?: string
  [key: string]: unknown
}

export interface MihomoRuleProvidersResponse {
  providers: Record<string, MihomoRuleProvider>
}

/** A single-node delay test result, in milliseconds. */
export interface MihomoDelayResult {
  delay: number
  url?: string
}

/** Per-node delay map returned by a group or provider health-check, in ms. */
export type MihomoDelayMap = Record<string, number>

export interface ConnectionMetadata {
  network?: string
  type?: string
  sourceIP?: string
  destinationIP?: string
  sourcePort?: string
  destinationPort?: string
  host?: string
  dnsMode?: string
  process?: string
  processPath?: string
  [key: string]: unknown
}

export interface MihomoConnection {
  id: string
  metadata: ConnectionMetadata
  upload: number
  download: number
  start: string
  chains: string[]
  providerChains?: string[]
  rule: string
  rulePayload: string
  [key: string]: unknown
}

export interface MihomoConnectionsSnapshot {
  downloadTotal: number
  uploadTotal: number
  memory: number
  connections: MihomoConnection[]
}

export interface MihomoTrafficMessage {
  up: number
  down: number
  upTotal: number
  downTotal: number
}

export interface MihomoLogMessage {
  type?: 'info' | 'warning' | 'error' | 'debug'
  payload?: string
  time?: string
  level?: string
  message?: string
  fields?: unknown[]
}

export interface MihomoConfigSnapshot {
  port?: number
  'socks-port'?: number
  'mixed-port'?: number
  mode?: 'rule' | 'global' | 'direct'
  'log-level'?: string
  'allow-lan'?: boolean
  ipv6?: boolean
  tun?: Record<string, unknown>
  [key: string]: unknown
}

/** A failure surfaced by a push stream (bad JSON, schema reject, or connect error). */
export interface MihomoStreamError {
  code: string
  message: string
  /** Which stream reported the failure. */
  source: 'traffic' | 'connections' | 'logs'
  /** `connection` = the socket dropped or could not be (re)opened; `parse` = a message was malformed. */
  kind: 'connection' | 'parse'
}
