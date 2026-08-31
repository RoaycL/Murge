import { z } from 'zod'
import type { MihomoConfigSnapshot, MihomoDnsQueryType } from '../mihomo-api'
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
