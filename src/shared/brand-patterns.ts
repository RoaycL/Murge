/**
 * Canonical brand field patterns.
 *
 * These are the single source of truth for the format of each brand string.
 * They are mirrored byte-for-byte in `docs/schemas/brand.schema.json` and used
 * by the runtime Zod schema in `src/shared/schemas/brand.ts`. A unit test
 * (`tests/brand-sync.test.ts`) asserts the JSON Schema patterns equal these
 * constants so the three validation surfaces cannot drift.
 *
 * Deliberate rules:
 * - `appId` (reverse-DNS bundle id) must start with a letter.
 * - `executableName` is a file-ish name: it must not contain a `.`.
 * - `protocolScheme` must start with a lowercase letter (RFC 3986 scheme).
 */

export const APP_ID_PATTERN = '^[A-Za-z][A-Za-z0-9.-]+$'
export const EXECUTABLE_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]*$'
export const PROTOCOL_SCHEME_PATTERN = '^[a-z][a-z0-9+.-]*$'

export const BRAND_PATTERN_FIELDS: Record<string, string> = {
  appId: APP_ID_PATTERN,
  executableName: EXECUTABLE_NAME_PATTERN,
  protocolScheme: PROTOCOL_SCHEME_PATTERN
}
