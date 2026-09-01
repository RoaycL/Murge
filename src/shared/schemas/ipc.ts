import { z } from 'zod'
import type { MihomoConfigSnapshot, MihomoDnsQueryType } from '../mihomo-api'
import type { OverrideInput } from '../overrides'
import type { DnsEnhancement } from '../dns'
import { isValidCidr, isValidDomainOrRule, isValidIp, isValidNameserver } from '../dns'
import type { SnifferEnhancement } from '../sniffer'
import { isValidAddressOrCidr, isValidPortToken } from '../sniffer'
import type { TunConfigModel } from '../tun-config'
import { isValidDnsHijackEntry, isValidTunDevice, isValidTunMtu, isValidTunRouteAddress } from '../tun-config'
import type { CoreSettings } from '../core-settings'
import type { GeodataSettings } from '../geodata'
import { ProtocolError, ProtocolErrorCode } from '../protocol-errors'
import { logLevelSchema } from './log-level'

/**
 * Runtime validation for every renderer-to-main IPC argument.
 *
 * These schemas run in the trusted main process before a service method is
 * called, so malformed renderer input can never reach a service. Unknown keys
 * are rejected (`.strict()`) because the renderer is our own surface and we do
 * not want to silently forward arbitrary fields into the controller.
 */

function invalid(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, message)
}

/**
 * Fields that the renderer is allowed to patch on the live controller config.
 *
 * Deliberately excludes `tun`: TUN is a high-privilege network configuration
 * that must not be forwarded as an arbitrary object by the renderer. A future
 * Phase will add a dedicated, strongly typed TUN IPC routed through the
 * privileged service instead.
 */
const patchableConfigKeys = {
  port: z.number().int().min(0).max(65535).optional(),
  'socks-port': z.number().int().min(0).max(65535).optional(),
  'mixed-port': z.number().int().min(0).max(65535).optional(),
  mode: z.enum(['rule', 'global', 'direct']).optional(),
  'log-level': logLevelSchema.optional(),
  'allow-lan': z.boolean().optional(),
  ipv6: z.boolean().optional()
} satisfies Record<string, z.ZodType>

const configPatchSchema = z.object(patchableConfigKeys).partial().strict()

/**
 * A non-empty string check that does NOT rewrite the value.
 *
 * Proxy group names, member names and connection ids are exact identifiers in
 * mihomo. Trimming would silently retarget the request to a different name, so
 * we only assert non-empty-after-trim while passing the original value through.
 */
const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must be a non-empty string'
})

const proxySelectionSchema = z.object({
  group: nonEmptyString,
  name: nonEmptyString
})

const connectionIdSchema = z.object({
  id: nonEmptyString
})

const delayOptionsSchema = z
  .object({
    // The probe URL is owned by the trusted main process (the renderer must not
    // make the controller fetch an arbitrary URL), so `url` is intentionally
    // absent and `.strict()` rejects it if a renderer ever sends one.
    timeout: z.number().int().min(1000).max(30000).optional()
  })
  .strict()

/** Validate a renderer-sent config patch. Rejects unknown keys and bad types. */
export function parseConfigPatch(input: unknown): Partial<MihomoConfigSnapshot> {
  if (!(typeof input === 'object' && input !== null && !Array.isArray(input))) {
    throw invalid('config patch must be an object')
  }
  const parsed = configPatchSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid config patch at ${detail?.path.join('.') || 'patch'}: ${detail?.message}`)
  }
  return parsed.data
}

/** Validate that a proxy selection names a non-empty group and member. */
export function parseProxySelection(group: unknown, name: unknown): { group: string; name: string } {
  const parsed = proxySelectionSchema.safeParse({ group, name })
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid proxy selection at ${detail?.path.join('.') || 'selection'}: ${detail?.message}`)
  }
  return parsed.data
}

/** Validate a connection id used to close a single connection. */
export function parseConnectionId(id: unknown): string {
  const parsed = connectionIdSchema.safeParse({ id })
  if (!parsed.success) throw invalid('connection id must be a non-empty string')
  return parsed.data.id
}

export function parseStartupEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid('startup enabled must be a boolean')
  return value
}

/**
 * Validate a partial application-settings patch from the renderer. Only known
 * keys are accepted; anything else is rejected so the IPC boundary cannot
 * write an unknown field into the persisted settings document.
 */
export function parseAppSettingsPatch(
  input: unknown
): {
  autoStartKernel?: boolean
  autoCheckUpdate?: boolean
  kernelEnabled?: boolean
  kernelChannel?: 'stable' | 'specific'
  kernelSpecificVersion?: string
} {
  if (!(typeof input === 'object' && input !== null && !Array.isArray(input))) {
    throw invalid('app settings patch must be an object')
  }
  const record = input as Record<string, unknown>
  const patch: {
    autoStartKernel?: boolean
    autoCheckUpdate?: boolean
    kernelEnabled?: boolean
    kernelChannel?: 'stable' | 'specific'
    kernelSpecificVersion?: string
  } = {}
  if ('autoStartKernel' in record) {
    if (typeof record.autoStartKernel !== 'boolean') throw invalid('autoStartKernel must be a boolean')
    patch.autoStartKernel = record.autoStartKernel
  }
  if ('autoCheckUpdate' in record) {
    if (typeof record.autoCheckUpdate !== 'boolean') throw invalid('autoCheckUpdate must be a boolean')
    patch.autoCheckUpdate = record.autoCheckUpdate
  }
  if ('kernelEnabled' in record) {
    if (typeof record.kernelEnabled !== 'boolean') throw invalid('kernelEnabled must be a boolean')
    patch.kernelEnabled = record.kernelEnabled
  }
  if ('kernelChannel' in record) {
    if (record.kernelChannel !== 'stable' && record.kernelChannel !== 'specific') {
      throw invalid('kernelChannel must be "stable" or "specific"')
    }
    patch.kernelChannel = record.kernelChannel
  }
  if ('kernelSpecificVersion' in record) {
    if (typeof record.kernelSpecificVersion !== 'string') {
      throw invalid('kernelSpecificVersion must be a string')
    }
    patch.kernelSpecificVersion = record.kernelSpecificVersion
  }
  return patch
}

/** Validate a specific kernel version string (leading `v` + semver-ish). */
export function parseKernelVersion(version: unknown): string {
  if (typeof version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(version)) {
    throw invalid('kernel version must look like "v1.19.30"')
  }
  return version
}

/** Validate a kernel-version channel toggle. */
export function parseKernelChannel(channel: unknown): 'stable' | 'specific' {
  if (channel !== 'stable' && channel !== 'specific') {
    throw invalid('kernel channel must be "stable" or "specific"')
  }
  return channel
}

export function parseKernelEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid('kernel enabled must be a boolean')
  return value
}

/** Validate a renderer-sent override create/update payload. */
export function parseOverrideInput(input: unknown): OverrideInput {
  if (!(typeof input === 'object' && input !== null && !Array.isArray(input))) {
    throw invalid('override input must be an object')
  }
  const record = input as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw invalid('override name must be a non-empty string')
  }
  const kind = record.kind
  if (kind !== 'yaml' && kind !== 'js') {
    throw invalid('override kind must be "yaml" or "js"')
  }
  const scope = record.scope
  if (scope !== 'global' && scope !== 'profile') {
    throw invalid('override scope must be "global" or "profile"')
  }
  let profileId: string | null = null
  if (scope === 'profile') {
    if (typeof record.profileId !== 'string' || record.profileId.trim().length === 0) {
      throw invalid('a profile-scoped override requires a non-empty profileId')
    }
    profileId = record.profileId
  }
  if (typeof record.content !== 'string') {
    throw invalid('override content must be a string')
  }
  return { name: name.trim(), kind, scope, profileId, content: record.content }
}

/** Validate an override id used in a mutation path. */
export function parseOverrideId(id: unknown): string {
  if (typeof id !== 'string' || id.trim().length === 0) throw invalid('override id must be a non-empty string')
  return id
}

/** Validate an override enable toggle. */
export function parseOverrideEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid('override enabled must be a boolean')
  return value
}

/** Validate an override reorder direction. */
export function parseOverrideMove(direction: unknown): 'up' | 'down' {
  if (direction !== 'up' && direction !== 'down') throw invalid('override move direction must be "up" or "down"')
  return direction
}

/** Validate a provider or node name used in a path segment. */
export function parseMihomoName(name: unknown): string {
  if (!(typeof name === 'string' && name.trim().length > 0)) throw invalid('name must be a non-empty string')
  return name
}

/** Validate a delay-test options object from the renderer. */
export function parseDelayOptions(input: unknown): { timeout?: number } {
  if (input === undefined) return {}
  if (!(typeof input === 'object' && input !== null && !Array.isArray(input))) {
    throw invalid('delay options must be an object')
  }
  const parsed = delayOptionsSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid delay options at ${detail?.path.join('.') || 'options'}: ${detail?.message}`)
  }
  return parsed.data
}

const dnsTypes = new Set<MihomoDnsQueryType>(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'HTTPS'])

export function parseDnsQuery(name: unknown, type: unknown): { name: string; type: MihomoDnsQueryType } {
  const labels = typeof name === 'string' ? name.split('.') : []
  const validName = typeof name === 'string' && name.length >= 1 && name.length <= 253 && labels.every(label =>
    label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  )
  if (!validName) {
    throw invalid('DNS name must be a valid ASCII hostname')
  }
  if (typeof type !== 'string' || !dnsTypes.has(type as MihomoDnsQueryType)) {
    throw invalid('DNS query type is not supported')
  }
  return { name, type: type as MihomoDnsQueryType }
}

const serverListSchema = z
  .array(z.string().refine(isValidNameserver, '无效的 DNS 服务器 URI'))
  .max(64)
const domainOrRuleSchema = z
  .string()
  .refine(isValidDomainOrRule, '必须是域名、*. 通配符或 geosite/geoip 规则')
const ipSchema = z.string().refine(isValidIp, '必须是有效的 IPv4 或 IPv6 地址')

const dnsEnhancementSchema = z
  .object({
    enabled: z.boolean(),
    enhancedMode: z.enum(['fake-ip', 'redir-host', 'normal']),
    ipv6: z.boolean(),
    respectRules: z.boolean(),
    fakeIpRange: z.string().refine(isValidCidr, '必须是有效的 CIDR 范围'),
    fakeIpFilterMode: z.enum(['blacklist', 'whitelist']),
    fakeIpFilter: z.array(domainOrRuleSchema),
    useHosts: z.boolean(),
    hosts: z.array(z.object({ domain: domainOrRuleSchema, address: ipSchema })),
    defaultNameserver: serverListSchema,
    proxyServerNameserver: serverListSchema,
    directNameserver: serverListSchema,
    nameserver: serverListSchema,
    fallback: serverListSchema,
    nameserverPolicy: z.array(z.object({ domain: domainOrRuleSchema, server: serverListSchema.element }))
  })
  .strict()

/**
 * Validate a renderer-sent DNS enhancement. Every server URI, IP, domain pattern
 * and CIDR must pass, and unknown keys are rejected, so an invalid enhancement
 * can never be persisted or reach the runtime config.
 */
export function parseDnsEnhancement(input: unknown): DnsEnhancement {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('dns enhancement must be an object')
  }
  const parsed = dnsEnhancementSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid dns enhancement at ${detail?.path.join('.') || 'dns'}: ${detail?.message}`)
  }
  return parsed.data
}

const portTokenSchema = z.string().refine(isValidPortToken, '端口必须是 1-65535、范围 (如 8080-8880) 或 *')
const addressOrCidrSchema = z.string().refine(isValidAddressOrCidr, '必须是有效的 IP 或 CIDR')

const snifferEnhancementSchema = z
  .object({
    enabled: z.boolean(),
    overrideDestination: z.boolean(),
    forceDnsMapping: z.boolean(),
    parsePureIp: z.boolean(),
    ports: z.object({
      http: z.array(portTokenSchema).max(64),
      tls: z.array(portTokenSchema).max(64),
      quic: z.array(portTokenSchema).max(64)
    }),
    skipDomain: z.array(domainOrRuleSchema).max(128),
    forceDomain: z.array(domainOrRuleSchema).max(128),
    skipSrcAddress: z.array(addressOrCidrSchema).max(128),
    skipDstAddress: z.array(addressOrCidrSchema).max(128)
  })
  .strict()

/**
 * Validate a renderer-sent sniffer enhancement. Every port, domain pattern and
 * address CIDR must pass, and unknown keys are rejected, so an invalid
 * enhancement can never be persisted or reach the runtime config.
 */
export function parseSnifferEnhancement(input: unknown): SnifferEnhancement {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('sniffer enhancement must be an object')
  }
  const parsed = snifferEnhancementSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid sniffer enhancement at ${detail?.path.join('.') || 'sniffer'}: ${detail?.message}`)
  }
  return parsed.data
}

const dnsHijackEntrySchema = z.string().refine(isValidDnsHijackEntry, '必须是 any、IP、主机:端口 或 [IPv6]:端口')
const routeCidrSchema = z.string().refine(isValidTunRouteAddress, '必须是有效的 IP 或 CIDR')

const tunConfigSchema = z
  .object({
    stack: z.enum(['mixed', 'system', 'gvisor']),
    device: z.string().refine(isValidTunDevice, 'TUN 设备名包含非法字符或长度'),
    mtu: z.number().int().min(576).max(65535),
    strictRoute: z.boolean(),
    autoRoute: z.boolean(),
    autoDetectInterface: z.boolean(),
    dnsHijack: z.array(dnsHijackEntrySchema).min(1).max(64),
    routeAddress: z.array(routeCidrSchema).max(128),
    routeExcludeAddress: z.array(routeCidrSchema).max(128)
  })
  .strict()

/**
 * Validate a renderer-sent TUN config model. Every stack, device, MTU, dns-hijack
 * entry and route CIDR must pass, and unknown keys are rejected, so an invalid
 * TUN configuration can never be persisted or reach the mihomo-owned bootstrap.
 */
export function parseTunConfig(input: unknown): TunConfigModel {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('tun config must be an object')
  }
  const parsed = tunConfigSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid tun config at ${detail?.path.join('.') || 'tun'}: ${detail?.message}`)
  }
  return parsed.data
}

const coreSettingsSchema = z
  .object({
    enabled: z.boolean(),
    logLevel: logLevelSchema,
    ipv6: z.boolean(),
    tcpConcurrent: z.boolean(),
    unifiedDelay: z.boolean(),
    findProcessMode: z.enum(['off', 'strict', 'always'])
  })
  .strict()

/**
 * Validate a renderer-sent controlled core-settings model. The log level must be
 * a real mihomo level, the find-process mode must be one of the three supported
 * values, and unknown keys are rejected, so an invalid model can never be
 * persisted or reach the runtime config.
 */
export function parseCoreSettings(input: unknown): CoreSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('core settings must be an object')
  }
  const parsed = coreSettingsSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid core settings at ${detail?.path.join('.') || 'core'}: ${detail?.message}`)
  }
  return parsed.data
}

const HTTPS_URL_OR_EMPTY = z
  .string()
  .refine((value) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return true
    try {
      const url = new URL(trimmed)
      return url.protocol === 'https:' || url.protocol === 'http:'
    } catch {
      return false
    }
  }, 'must be an absolute https/http URL')

const geodataSettingsSchema = z
  .object({
    enabled: z.boolean(),
    geodataMode: z.boolean(),
    geoipMode: z.enum(['memconservative', 'standard']),
    autoUpdate: z.boolean(),
    updateIntervalHours: z.number().int().min(1).max(168),
    geoxUrl: HTTPS_URL_OR_EMPTY
  })
  .strict()

/**
 * Validate a renderer-sent controlled geodata-settings model. The geodata mode
 * must be a boolean, the geoip mode one of the two supported values, the update
 * interval a bounded integer of hours, the source URL an absolute URL (or empty),
 * and unknown keys are rejected, so an invalid model can never be persisted or
 * reach the runtime config.
 */
export function parseGeodataSettings(input: unknown): GeodataSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('geodata settings must be an object')
  }
  const parsed = geodataSettingsSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid geodata settings at ${detail?.path.join('.') || 'geodata'}: ${detail?.message}`)
  }
  return parsed.data
}
