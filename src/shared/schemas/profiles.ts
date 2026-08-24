import { z } from 'zod'
import type { ProfileSubscription, ProfilePatch } from '../profiles'
import { ProtocolError, ProtocolErrorCode } from '../protocol-errors'

/**
 * Runtime validation for every renderer-to-main profile IPC argument.
 *
 * These schemas run in the trusted main process. Unknown keys are rejected
 * (`.strict()`) and secret material is never accepted as a field — a renderer
 * cannot smuggle credentials in as a distinct key (see `parseImportRequest`).
 */

function invalid(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, message)
}

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must be a non-empty string'
})

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

const configEditSchema = z
  .object({
    key: nonEmptyString,
    value: z.string()
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
export function parseConfigEdit(input: unknown): { key: string; value: string } {
  if (!(typeof input === 'object' && input !== null && !Array.isArray(input))) {
    throw invalid('config edit must be an object')
  }
  const parsed = configEditSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    throw invalid(`invalid config edit at ${detail?.path.join('.') || 'edit'}: ${detail?.message}`)
  }
  return parsed.data
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
