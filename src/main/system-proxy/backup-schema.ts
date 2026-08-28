import { z } from 'zod'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '../../shared/system-proxy'

export const SYSTEM_PROXY_BACKUP_SCHEMA_VERSION = 1

/**
 * Strict Zod schema for a persisted system-proxy backup.
 *
 * This is the single source of truth for what a backup may look like. It is much
 * stricter than the previous ad-hoc shape check: the schema version is an exact
 * literal, the target host must be the loopback host and the port a safe integer
 * in range, `createdAt` must be a real ISO-8601 timestamp, and *every* registry
 * value must carry a consistent `exists`/`type`/`value` triple using the raw
 * registry type names. Every persisted object is `.strict()`, so an unknown key
 * anywhere in the bundle is a schema mismatch and the backup is rejected instead
 * of being silently stripped. A corrupt or inconsistent backup must never be
 * trusted enough to write back to the registry — validation fails closed, which
 * surfaces to the user instead of guessing.
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

/** `true` when the registry value carries a numeric (DWORD/QWORD) payload. */
export function isNumericRegistryType(type: string): boolean {
  return type === 'REG_DWORD' || type === 'REG_QWORD'
}

export const registryValueSchema = z
  .object({
    exists: z.boolean(),
    type: z.enum(REGISTRY_VALUE_TYPES),
    // Numeric payloads must be safe integers (no floats, no unsafe big ints);
    // strings cover SZ/EXPAND_SZ/MULTI_SZ/BINARY and absent is always null.
    value: z.union([z.string(), z.number().safe(), z.null()])
  })
  .strict()
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
    const numeric = isNumericRegistryType(value.type)
    if (numeric && (typeof value.value !== 'number' || !Number.isSafeInteger(value.value) || value.value < 0)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `a ${value.type} must be a non-negative safe integer` })
    }
    if (!numeric && value.type !== 'none' && typeof value.value !== 'string') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `a ${value.type} must be a string` })
    }
  })

const proxyStateSchema = z
  .object({
    proxyEnable: registryValueSchema,
    proxyServer: registryValueSchema,
    proxyOverride: registryValueSchema
  })
  .strict()

export const systemProxyBackupSchema = z
  .object({
    schemaVersion: z.literal(SYSTEM_PROXY_BACKUP_SCHEMA_VERSION),
    instanceId: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    target: z
      .object({
        host: z.literal(SYSTEM_PROXY_LOOPBACK_HOST),
        port: z.number().safe().int().min(1).max(65535)
      })
      .strict(),
    previous: proxyStateSchema,
    written: proxyStateSchema
  })
  .strict()

/** Validate an unknown backup payload, throwing a ZodError on a mismatch. */
export function parseSystemProxyBackup(input: unknown) {
  return systemProxyBackupSchema.parse(input)
}
