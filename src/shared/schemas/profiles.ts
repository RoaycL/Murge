import { z } from 'zod'
import type { ProfileSubscription, ProfilePatch, ConfigEdit } from '../profiles'
import { ProtocolError, ProtocolErrorCode } from '../protocol-errors'

/**
 * Runtime validation for every renderer-to-main profile IPC argument.
 *
 * These schemas run in the trusted main process. Unknown keys are rejected
 * (`.strict()`) and secret material is never accepted as a distinct key — a
 * renderer cannot smuggle credentials in as a separate field (see `parseImportRequest`).
 */

function invalid(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, message)
}

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must be a non-empty string'
})

/**
 * Supported config-edit keys.
 *
 * Mirrors `patchableConfigKeys` in `./ipc.ts` on purpose: an edit ends up in the
 * document the kernel loads, so the renderer must not be able to write an
 * arbitrary key. `tun` is deliberately absent — it is high-privilege network
 * configuration that must never arrive as free-form text from the renderer.
 * Restricting the key also prevents writing a key containing `:` or a newline,
 * which would otherwise emit structurally invalid YAML.
 */
const configEditKeySchema = z.enum([
  'port',
  'socks-port',
  'mixed-port',
  'mode',
  'log-level',
  'allow-lan',
  'ipv6'
])

/**
 * Per-key value constraints. These align with `patchableConfigKeys` in `./ipc.ts`,
 * except `log-level` is tightened to mihomo's actual accepted set
 * (`LogLevelMapping`: silent/error/warning/info/debug) rather than an open string,
 * because an unrecognized level written into the document makes the kernel reject
 * the whole config on load. Values cross the wire as strings (they are written
 * verbatim into YAML), so each key validates the string FORM of its type.
 */
const PORT_PATTERN = /^\d{1,5}$/
const configEditValueByKey: Record<z.infer<typeof configEditKeySchema>, z.ZodType<string>> = {
  port: portValue(),
  'socks-port': portValue(),
  'mixed-port': portValue(),
  mode: z.enum(['rule', 'global', 'direct']),
  'log-level': z.enum(['silent', 'error', 'warning', 'info', 'debug']),
  'allow-lan': z.enum(['true', 'false']),
  ipv6: z.enum(['true', 'false'])
}

function portValue(): z.ZodType<string> {
  return z.string().refine((value) => {
    if (!PORT_PATTERN.test(value)) return false
    const port = Number(value)
    return port >= 0 && port <= 65535
  }, 'must be a port number between 0 and 65535')
}

// A value is written verbatim into the YAML document, so it must never contain a
// line break (that would inject an additional key) — and it must additionally
// satisfy the per-key type constraint applied in `parseConfigEdit`.
const safeValue = z.string().refine(
  (value) => !value.includes('\n') && !value.includes('\r'),
  'edit values cannot contain line breaks (YAML injection prevention)'
)

const sourceSchema = z
  .object({
    type: z.enum(['url', 'file', 'manual']),
    url: z.string().max(2048).optional(),
    path: z.string().max(2048).optional(),
    expire: z.number().int().positive().nullable().optional(),
    usage: z
      .object({
        upload: z.number().nonnegative(),
        download: z.number().nonnegative(),
        total: z.number().nonnegative()
      })
      .nullable()
      .optional()
  })
  .strict()

const importRequestSchema = z
  .object({
    name: nonEmptyString,
    document: z.string().min(1),
    source: sourceSchema,
    activate: z.boolean().optional()
  })
  .strict()

// MEDIUM FIX: Use enum for key and typed value constraints
const configEditSchema = z
  .object({
    key: configEditKeySchema,
    value: safeValue
  })
  .strict()

const profilePatchSchema = z
  .object({
    name: nonEmptyString.optional(),
    source: sourceSchema.optional()
  })
  .strict()

/** Validate a profile id or name used as a path segment / identifier. */
export function parseProfileName(name: unknown): string {
  if (!(typeof name === 'string' && name.trim().length > 0)) throw invalid('profile name/id must be a non-empty string')
  return name
}

/** Validate an import request object. Returns a typed record for the service. */
export function parseImportRequest(input: unknown): {
  name: string
  document: string
  source: ProfileSubscription
  activate: boolean
} {
  if (!(typeof input === 'object' && input !== null && !Array.isArray(input))) {
    throw invalid('import request must be an object')
  }
  const parsed = importRequestSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid import request at ${detail?.path.join('.') || 'request'}: ${detail?.message}`)
  }
  return { activate: false, ...parsed.data }
}

/** Validate a supported config edit. Returns a typed ConfigEdit record. */
export function parseConfigEdit(input: unknown): ConfigEdit {
  if (!(typeof input === 'object' && input !== null && !Array.isArray(input))) {
    throw invalid('config edit must be an object')
  }
  const parsed = configEditSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid config edit at ${detail?.path.join('.') || 'edit'}: ${detail?.message}`)
  }

  // Enforce the per-key value constraint. Keeping this in one table (rather than a
  // switch) keeps it aligned with `patchableConfigKeys` and makes a missing key a
  // type error instead of a silently unvalidated value.
  const { key, value } = parsed.data
  const valueSchema = configEditValueByKey[key]
  const valueParsed = valueSchema.safeParse(value)
  if (!valueParsed.success) {
    throw invalid(`invalid config edit at value: ${key} ${valueParsed.error.issues[0]?.message}`)
  }

  return { key, value }
}

/** Validate a partial profile edit (rename / re-source). */
export function parseProfilePatch(input: unknown): ProfilePatch {
  if (!(typeof input === 'object' && input !== null && !Array.isArray(input))) {
    throw invalid('profile patch must be an object')
  }
  const parsed = profilePatchSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid profile patch at ${detail?.path.join('.') || 'patch'}: ${detail?.message}`)
  }
  return parsed.data
}
