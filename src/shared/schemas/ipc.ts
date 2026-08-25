import { z } from 'zod'
import type { MihomoConfigSnapshot } from '../mihomo-api'
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
