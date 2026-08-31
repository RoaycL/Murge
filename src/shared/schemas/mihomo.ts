import { z } from 'zod'
import type {
  MihomoConfigSnapshot,
  MihomoConnection,
  MihomoConnectionsSnapshot,
  MihomoDelayMap,
  MihomoDelayResult,
  MihomoDnsQueryResult,
  MihomoLogMessage,
  MihomoProxiesResponse,
  MihomoProxy,
  MihomoProxyProvider,
  MihomoProxyProvidersResponse,
  MihomoRule,
  MihomoRuleProvider,
  MihomoRuleProvidersResponse,
  MihomoRulesResponse,
  MihomoTrafficMessage,
  MihomoVersion
} from '../mihomo-api'
import { ProtocolError, ProtocolErrorCode } from '../protocol-errors'

/**
 * Runtime validation and normalization for mihomo controller payloads.
 *
 * Every schema uses `.passthrough()` on object shapes that upstream could
 * extend with new fields, so forward-compatible additions do not break parsing.
 * Required primitives are enforced and produce a typed INVALID_UPSTREAM error.
 */

const fail = (label: string, message: string): ProtocolError => {
  return new ProtocolError(ProtocolErrorCode.INVALID_UPSTREAM, `Invalid ${label} payload: ${message}`, {
    path: label,
    reason: message
  })
}

const versionSchema = z.object({
  meta: z.boolean(),
  version: z.string()
}).passthrough()

const delayHistorySchema = z
  .object({
    time: z.string(),
    delay: z.number()
  })
  .passthrough()

const proxySchema = z
  .object({
    name: z.string(),
    type: z.string(),
    udp: z.boolean().optional(),
    alive: z.boolean().optional(),
    history: z.array(delayHistorySchema).optional(),
    now: z.string().optional(),
    all: z.array(z.string()).optional(),
    hidden: z.boolean().optional(),
    icon: z.string().optional(),
    testUrl: z.string().optional(),
    fixed: z.string().optional()
  })
  .passthrough()

const proxiesResponseSchema = z
  .object({
    proxies: z.record(z.string(), proxySchema)
  })
  .passthrough()

const configSchema = z
  .object({
    port: z.number().optional(),
    'socks-port': z.number().optional(),
    'mixed-port': z.number().optional(),
    mode: z.enum(['rule', 'global', 'direct']).optional(),
    'log-level': z.string().optional(),
    'allow-lan': z.boolean().optional(),
    ipv6: z.boolean().optional(),
    tun: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough()

const ruleSchema = z
  .object({
    index: z.number(),
    type: z.string(),
    payload: z.string(),
    proxy: z.string(),
    size: z.number(),
    extra: z
      .object({
        disabled: z.boolean().optional(),
        hitCount: z.number().optional(),
        hitAt: z.string().optional(),
        missCount: z.number().optional(),
        missAt: z.string().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough()

const rulesResponseSchema = z
  .object({
    rules: z.array(ruleSchema)
  })
  .passthrough()

const providerShared = {
  name: z.string(),
  type: z.string(),
  behavior: z.string().optional(),
  now: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
  updatedAt: z.string().optional()
}

const proxyProviderSchema = z
  .object({
    ...providerShared,
    vehicleType: z.string().optional(),
    proxies: z.array(proxySchema).optional(),
    testUrl: z.string().optional(),
    expectedStatus: z.string().optional(),
    subscriptionInfo: z
      .object({
        Upload: z.number().optional(),
        Download: z.number().optional(),
        Total: z.number().optional(),
        Expire: z.number().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough()

const proxyProvidersResponseSchema = z
  .object({
    providers: z.record(z.string(), proxyProviderSchema)
  })
  .passthrough()

const ruleProviderSchema = z
  .object({
    ...providerShared,
    vehicleType: z.string().optional(),
    format: z.string().optional(),
    ruleCount: z.number().optional()
  })
  .passthrough()

const ruleProvidersResponseSchema = z
  .object({
    providers: z.record(z.string(), ruleProviderSchema)
  })
  .passthrough()

const delayResultSchema = z
  .object({
    delay: z.number(),
    url: z.string().optional()
  })
  .passthrough()

const delayMapSchema = z.record(z.string(), z.number())

const dnsQuestionSchema = z.object({ name: z.string(), type: z.number().int().nonnegative() }).passthrough()
const dnsRecordSchema = z.object({
  name: z.string(), type: z.number().int().nonnegative(), TTL: z.number().int().nonnegative(), data: z.string()
}).passthrough()
const dnsQuerySchema = z.object({
  Status: z.number().int().nonnegative(),
  Question: z.array(dnsQuestionSchema),
  TC: z.boolean(), RD: z.boolean(), RA: z.boolean(), AD: z.boolean(), CD: z.boolean(),
  Answer: z.array(dnsRecordSchema).optional(),
  Authority: z.array(dnsRecordSchema).optional(),
  Additional: z.array(dnsRecordSchema).optional()
}).passthrough()

const connectionMetadataSchema = z
  .object({
    network: z.string().optional(),
    type: z.string().optional(),
    sourceIP: z.string().optional(),
    destinationIP: z.string().optional(),
    sourcePort: z.string().optional(),
    destinationPort: z.string().optional(),
    host: z.string().optional(),
    dnsMode: z.string().optional(),
    process: z.string().optional(),
    processPath: z.string().optional()
  })
  .passthrough()

const connectionSchema = z
  .object({
    id: z.string(),
    metadata: connectionMetadataSchema,
    upload: z.number(),
    download: z.number(),
    start: z.string(),
    chains: z.array(z.string()),
    providerChains: z.array(z.string()).optional(),
    rule: z.string(),
    rulePayload: z.string()
  })
  .passthrough()

const connectionsSnapshotSchema = z
  .object({
    downloadTotal: z.number(),
    uploadTotal: z.number(),
    memory: z.number(),
    connections: z.array(connectionSchema)
  })
  .passthrough()

const trafficSchema = z
  .object({
    up: z.number(),
    down: z.number(),
    upTotal: z.number(),
    downTotal: z.number()
  })
  .passthrough()

const logSchema = z
  .object({
    type: z.enum(['info', 'warning', 'error', 'debug']).optional(),
    payload: z.string().optional(),
    time: z.string().optional(),
    level: z.string().optional(),
    message: z.string().optional(),
    fields: z.array(z.unknown()).optional()
  })
  .passthrough()

export function parseMihomoVersion(input: unknown): MihomoVersion {
  const parsed = versionSchema.safeParse(input)
  if (!parsed.success) throw fail('version', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoConfig(input: unknown): MihomoConfigSnapshot {
  const parsed = configSchema.safeParse(input)
  if (!parsed.success) throw fail('configs', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoProxies(input: unknown): MihomoProxiesResponse {
  const parsed = proxiesResponseSchema.safeParse(input)
  if (!parsed.success) throw fail('proxies', parsed.error.issues[0]?.message)
  return parsed.data as MihomoProxiesResponse
}

export function parseMihomoProxy(input: unknown): MihomoProxy {
  const parsed = proxySchema.safeParse(input)
  if (!parsed.success) throw fail('proxy', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoRules(input: unknown): MihomoRulesResponse {
  const parsed = rulesResponseSchema.safeParse(input)
  if (!parsed.success) throw fail('rules', parsed.error.issues[0]?.message)
  return parsed.data as MihomoRulesResponse
}

export function parseMihomoRule(input: unknown): MihomoRule {
  const parsed = ruleSchema.safeParse(input)
  if (!parsed.success) throw fail('rule', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoProxyProviders(input: unknown): MihomoProxyProvidersResponse {
  const parsed = proxyProvidersResponseSchema.safeParse(input)
  if (!parsed.success) throw fail('proxy-providers', parsed.error.issues[0]?.message)
  return parsed.data as MihomoProxyProvidersResponse
}

export function parseMihomoProxyProvider(input: unknown): MihomoProxyProvider {
  const parsed = proxyProviderSchema.safeParse(input)
  if (!parsed.success) throw fail('proxy-provider', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoRuleProviders(input: unknown): MihomoRuleProvidersResponse {
  const parsed = ruleProvidersResponseSchema.safeParse(input)
  if (!parsed.success) throw fail('rule-providers', parsed.error.issues[0]?.message)
  return parsed.data as MihomoRuleProvidersResponse
}

export function parseMihomoRuleProvider(input: unknown): MihomoRuleProvider {
  const parsed = ruleProviderSchema.safeParse(input)
  if (!parsed.success) throw fail('rule-provider', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoDelayResult(input: unknown): MihomoDelayResult {
  const parsed = delayResultSchema.safeParse(input)
  if (!parsed.success) throw fail('delay-result', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoDelayMap(input: unknown): MihomoDelayMap {
  const parsed = delayMapSchema.safeParse(input)
  if (!parsed.success) throw fail('delay-map', parsed.error.issues[0]?.message)
  return parsed.data as MihomoDelayMap
}

export function parseMihomoDnsQuery(input: unknown): MihomoDnsQueryResult {
  const parsed = dnsQuerySchema.safeParse(input)
  if (!parsed.success) throw fail('dns-query', parsed.error.issues[0]?.message)
  return parsed.data as MihomoDnsQueryResult
}

export function parseMihomoConnection(input: unknown): MihomoConnection {
  const parsed = connectionSchema.safeParse(input)
  if (!parsed.success) throw fail('connection', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoConnections(input: unknown): MihomoConnectionsSnapshot {
  const parsed = connectionsSnapshotSchema.safeParse(input)
  if (!parsed.success) throw fail('connections', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoTraffic(input: unknown): MihomoTrafficMessage {
  const parsed = trafficSchema.safeParse(input)
  if (!parsed.success) throw fail('traffic', parsed.error.issues[0]?.message)
  return parsed.data
}

export function parseMihomoLog(input: unknown): MihomoLogMessage {
  const parsed = logSchema.safeParse(input)
  if (!parsed.success) throw fail('log', parsed.error.issues[0]?.message)
  return parsed.data
}
