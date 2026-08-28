import { z } from 'zod'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '../../shared/system-proxy'

export const SYSTEM_PROXY_BACKUP_SCHEMA_VERSION = 1

/**
 * Strict Zod schema for a persisted system-proxy backup.
 *
 * This is the single source of truth for what a backup may look like. It is much
 * stricter than the previous ad-hoc shape check: the schema version is an exact
 * literal, the target host must be the loopback host and the port in range, and
 * *every* registry value must carry a consistent `exists`/`type`/`value` triple
 * using the raw registry type names. A corrupt or inconsistent backup must never
 * be trusted enough to write back to the registry — validation fails closed,
 * which surfaces to the user instead of guessing.
 */

const REGISTRY_VALUE_TYPES = [
  'REG_DWORD',
  'REG_SZ',
  'REG_EXPAND_SZ',
  'REG_MULTI_SZ',
  'REG_BINARY',
  'REG_QWORD',
  'none'
] as const

export const registryValueSchema = z
  .object({
    exists: z.boolean(),
    type: z.enum(REGISTRY_VALUE_TYPES),
    value: z.union([z.string(), z.number(), z.null()])
  })
  .superRefine((value, ctx) => {
    if (!value.exists) {
      if (value.type !== 'none' || value.value !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'an absent value must be { type: "none", value: null }'
        })
      }
      return
    }
    if (value.type === 'none') {
      ctx.addIssue({ code: 'custom', path: ['type'], message: 'a present value cannot have type "none"' })
    }
    const numeric = value.type === 'REG_DWORD' || value.type === 'REG_QWORD'
    if (numeric && (typeof value.value !== 'number' || !Number.isInteger(value.value) || value.value < 0)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `a ${value.type} must be a non-negative integer` })
    }
    if (!numeric && value.type !== 'none' && typeof value.value !== 'string') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `a ${value.type} must be a string` })
    }
  })

const proxyStateSchema = z.object({
  proxyEnable: registryValueSchema,
  proxyServer: registryValueSchema,
  proxyOverride: registryValueSchema
})

export const systemProxyBackupSchema = z.object({
  schemaVersion: z.literal(SYSTEM_PROXY_BACKUP_SCHEMA_VERSION),
  instanceId: z.string().min(1),
  createdAt: z.string().min(1),
  target: z.object({
    host: z.literal(SYSTEM_PROXY_LOOPBACK_HOST),
    port: z.number().int().min(1).max(65535)
  }),
  previous: proxyStateSchema,
  written: proxyStateSchema
})

/** Validate an unknown backup payload, throwing a ZodError on a mismatch. */
export function parseSystemProxyBackup(input: unknown) {
  return systemProxyBackupSchema.parse(input)
}
