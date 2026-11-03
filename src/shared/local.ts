/**
 * 本地节点与规则: the user's own nodes, rules and edits to subscription
 * rules, kept outside the subscription and re-applied on every config build
 * (src-tauri/src/local_edits.rs owns the semantics).
 */

/** A mihomo proxy map (`name`, `type`, ...), passed through verbatim. */
export type ProxyConfig = Record<string, unknown> & { name: string; type: string }

export interface LocalNode {
  id: string
  enabled: boolean
  config: ProxyConfig
  /** Existing policy groups this node is appended to. */
  groups: string[]
  /** Tailscale only: route `*.ts.net` and the tailnet ranges to this node. */
  tailnetRules: boolean
}

export interface LocalRule {
  id: string
  enabled: boolean
  /** A full rule line, e.g. `DOMAIN-SUFFIX,example.com,Proxy`. */
  rule: string
}

export type RuleEditAction = 'disable' | 'retarget' | 'replace'

/** A change to one of the subscription's own rules, matched by content. */
export interface RuleEdit {
  id: string
  /** Controller spelling (`DomainSuffix`) or config keyword. */
  ruleType: string
  payload: string
  target: string
  action: RuleEditAction
  newTarget?: string | null
  replacement?: string | null
}

/** An external policy list (proxy-provider URL) of a local group. */
export interface GroupProvider {
  url: string
  /** Seconds; 0 = only when updated by hand. */
  interval: number
}

export type LocalGroupType = 'select' | 'url-test' | 'fallback' | 'load-balance'

/** A policy group created in the app, appended after the subscription's. */
export interface LocalGroup {
  id: string
  enabled: boolean
  /** The mihomo proxy-group map (`name`, `type`, `proxies`, `include-all-proxies`, `filter`, ...). */
  config: Record<string, unknown> & { name: string; type: LocalGroupType }
  /** Also contain the members of these groups. */
  includeGroups: string[]
  providers: GroupProvider[]
}

export interface LocalSettings {
  nodes: LocalNode[]
  /** Policy groups created in the app. */
  groups: LocalGroup[]
  rules: LocalRule[]
  /** Subscription rule edits, by profile id. */
  profileEdits: Record<string, RuleEdit[]>
  /** Hand tailnet traffic to the official Tailscale client when it runs. */
  tailscaleCoexist: boolean
}

export interface LocalState {
  settings: LocalSettings
  profile: { id: string | null; name: string | null } | null
  /** Policies a rule may target in the active subscription. */
  targets: string[]
  /** Policy groups of the active subscription, then the local ones (`local`). */
  groups: Array<{ name: string; type: string; local?: boolean }>
  warnings: string[]
  staleEdits: string[]
  skippedNodes: string[]
  skippedRules: string[]
  skippedGroups?: string[]
  tailscale: { detected: boolean; interface: string | null; active: boolean }
  /** Names of proxies the app injects itself. */
  managedProxies: string[]
}

export const EMPTY_LOCAL_SETTINGS: LocalSettings = {
  nodes: [],
  groups: [],
  rules: [],
  profileEdits: {},
  tailscaleCoexist: true
}

export const EMPTY_LOCAL_STATE: LocalState = {
  settings: EMPTY_LOCAL_SETTINGS,
  profile: null,
  targets: ['DIRECT', 'REJECT'],
  groups: [],
  warnings: [],
  staleEdits: [],
  skippedNodes: [],
  skippedRules: [],
  tailscale: { detected: false, interface: null, active: false },
  managedProxies: []
}

/**
 * Proxies the app injects itself (HTTPS 解密, Tailscale 共存); never offered
 * as a user target. The Rust service reports the names in `managedProxies`.
 */
export function isManagedProxy(state: Pick<LocalState, 'managedProxies'>, name: string): boolean {
  return state.managedProxies.includes(name)
}

/**
 * Controller rule type (`/rules` → `type`) to config keyword. Logic and
 * sub rules are absent: their controller payload is not the config syntax,
 * so they cannot be edited by content.
 */
export const RULE_TYPE_KEYWORDS: Record<string, string> = {
  Domain: 'DOMAIN',
  DomainSuffix: 'DOMAIN-SUFFIX',
  DomainKeyword: 'DOMAIN-KEYWORD',
  DomainRegex: 'DOMAIN-REGEX',
  DomainWildcard: 'DOMAIN-WILDCARD',
  GeoSite: 'GEOSITE',
  GeoIP: 'GEOIP',
  SrcGeoIP: 'SRC-GEOIP',
  IPASN: 'IP-ASN',
  SrcIPASN: 'SRC-IP-ASN',
  IPCIDR: 'IP-CIDR',
  SrcIPCIDR: 'SRC-IP-CIDR',
  IPSuffix: 'IP-SUFFIX',
  SrcIPSuffix: 'SRC-IP-SUFFIX',
  SrcPort: 'SRC-PORT',
  DstPort: 'DST-PORT',
  InPort: 'IN-PORT',
  InUser: 'IN-USER',
  InName: 'IN-NAME',
  InType: 'IN-TYPE',
  ProcessName: 'PROCESS-NAME',
  ProcessPath: 'PROCESS-PATH',
  ProcessNameRegex: 'PROCESS-NAME-REGEX',
  ProcessPathRegex: 'PROCESS-PATH-REGEX',
  ProcessNameWildcard: 'PROCESS-NAME-WILDCARD',
  ProcessPathWildcard: 'PROCESS-PATH-WILDCARD',
  Match: 'MATCH',
  RuleSet: 'RULE-SET',
  Network: 'NETWORK',
  DSCP: 'DSCP',
  Uid: 'UID'
}

/** The common rule types offered when writing a local rule. */
export const LOCAL_RULE_TYPES = [
  'DOMAIN-SUFFIX',
  'DOMAIN',
  'DOMAIN-KEYWORD',
  'DOMAIN-WILDCARD',
  'DOMAIN-REGEX',
  'GEOSITE',
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'IP-ASN',
  'SRC-IP-CIDR',
  'DST-PORT',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'RULE-SET',
  'NETWORK',
  'MATCH'
] as const

/** Types whose `no-resolve` flag matters. */
export const IP_RULE_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN', 'IP-SUFFIX'])

/** Split a rule line on top-level commas (logic payloads keep theirs). */
export function splitRuleLine(line: string): string[] {
  const fields: string[] = []
  let depth = 0
  let current = ''
  for (const ch of line) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth <= 0) {
      fields.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current.trim())
  return fields
}

export interface ParsedRule {
  type: string
  payload: string
  target: string
  noResolve: boolean
}

export function parseRuleLine(line: string): ParsedRule | null {
  const fields = splitRuleLine(line.trim())
  const type = (fields[0] ?? '').toUpperCase()
  if (!type) return null
  if (type === 'MATCH' || type === 'FINAL') {
    return fields[1] ? { type: 'MATCH', payload: '', target: fields[1], noResolve: false } : null
  }
  if (fields.length < 3 || !fields[1] || !fields[2]) return null
  return { type, payload: fields[1], target: fields[2], noResolve: fields.slice(3).some((f) => f.toLowerCase() === 'no-resolve') }
}

export function formatRuleLine(rule: ParsedRule): string {
  if (rule.type === 'MATCH') return `MATCH,${rule.target}`
  const parts = [rule.type, rule.payload.trim(), rule.target]
  if (rule.noResolve && IP_RULE_TYPES.has(rule.type)) parts.push('no-resolve')
  return parts.join(',')
}

/** Normalized identity of a rule, comparable with a `/rules` row. */
export function ruleIdentity(type: string, payload: string, target: string): string {
  let flat = type.replace(/[-_]/g, '').toUpperCase()
  if (flat === 'IPCIDR6') flat = 'IPCIDR'
  if (flat === 'SRCIPCIDR6') flat = 'SRCIPCIDR'
  if (flat === 'FINAL') flat = 'MATCH'
  return `${flat}|${payload.trim().toLowerCase()}|${target.trim()}`
}

/** Tailscale's tailnet rules for a node (local_edits.rs `tailnet_rules_for`). */
export function tailnetRulesFor(name: string): string[] {
  return [
    `DOMAIN-SUFFIX,ts.net,${name}`,
    `IP-CIDR,100.64.0.0/10,${name},no-resolve`,
    `IP-CIDR6,fd7a:115c:a1e0::/48,${name},no-resolve`
  ]
}

/** `ts://<name>` must parse as a URL host. */
export function isTailscaleDnsSafeName(name: string): boolean {
  return name.length > 0 && !/[\s/?#@:%[\]]/.test(name)
}

export function newLocalId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Deep copy of JSON data; works on Vue reactive proxies (structuredClone does not). */
export function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
