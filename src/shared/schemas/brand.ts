import { z } from 'zod'
import type { BrandConfig } from '../brand'
import { APP_ID_PATTERN, EXECUTABLE_NAME_PATTERN, PROTOCOL_SCHEME_PATTERN } from '../brand-patterns'
import { ProtocolError, ProtocolErrorCode } from '../protocol-errors'

/**
 * Runtime schema for `brand.config.json`. The file also carries a `$schema`
 * annotation, so unknown keys are preserved rather than rejected.
 */
const brandConfigSchema = z
  .object({
    productName: z.string().trim().min(1),
    shortName: z.string().trim().min(1),
    description: z.string(),
    appId: z.string().min(1).regex(new RegExp(APP_ID_PATTERN)),
    executableName: z.string().min(1).regex(new RegExp(EXECUTABLE_NAME_PATTERN)),
    protocolScheme: z.string().min(1).regex(new RegExp(PROTOCOL_SCHEME_PATTERN)),
    companyName: z.string(),
    repositoryUrl: z.string(),
    supportUrl: z.string(),
    copyright: z.string()
  })
  .passthrough()

/**
 * Validate an unknown brand payload and return a strongly typed BrandConfig.
 *
 * Throws a typed ProtocolError on any invalid, missing or wrong-typed field so
 * the startup path can reject a broken brand document loudly.
 */
export function parseBrandConfig(input: unknown): BrandConfig {
  const parsed = brandConfigSchema.safeParse(input)
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.') || 'brand'
    const message = parsed.error.issues[0]?.message || 'invalid brand configuration'
    throw new ProtocolError(ProtocolErrorCode.INVALID_BRAND, `Invalid brand configuration at ${path}: ${message}`, {
      path,
      reason: message
    })
  }
  return parsed.data as BrandConfig
}
