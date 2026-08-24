/**
 * Typed, cross-process error contract.
 *
 * The renderer and main process are separated by Electron IPC. When a handler
 * in main throws a `ProtocolError`, Electron only preserves the message string
 * across the boundary (custom properties are dropped). To carry the machine
 * readable code through IPC without changing every channel's return shape, we
 * encode the code into the message with a stable prefix and decode it on the
 * renderer side.
 */

export const ProtocolErrorCode = {
  /** A renderer-to-main IPC argument was malformed or missing. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** The brand configuration document is invalid. */
  INVALID_BRAND: 'INVALID_BRAND',
  /** An upstream mihomo payload did not match its expected shape. */
  INVALID_UPSTREAM: 'INVALID_UPSTREAM',
  /** The requested capability is not supported by this build or upstream. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** A requested entity was not found. */
  NOT_FOUND: 'NOT_FOUND',
  /** An unexpected internal failure. */
  INTERNAL: 'INTERNAL'
} as const

export type ProtocolErrorCode = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode]

/**
 * Shared prefix used to serialize a `ProtocolError` into a plain error message
 * so the code survives Electron IPC. Kept brand-neutral.
 */
export const PROTOCOL_ERROR_PREFIX = 'PROTOCOL_ERROR:'

const SUPPORTED_CODES = new Set<string>(Object.values(ProtocolErrorCode))

export interface ProtocolErrorDetails {
  /** The offending path or field, when known. */
  path?: string
  /** Human readable explanation of the failure. */
  reason?: string
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode
  readonly details?: ProtocolErrorDetails

  constructor(code: ProtocolErrorCode, message: string, details?: ProtocolErrorDetails) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.details = details
  }
}

/** Serialize a ProtocolError into a string that survives Electron IPC. */
export function encodeProtocolError(error: ProtocolError): string {
  return `${PROTOCOL_ERROR_PREFIX}${error.code}::${error.message}`
}

export interface DecodedProtocolError {
  code: ProtocolErrorCode
  message: string
}

/**
 * Attempt to decode a cross-boundary error message into a `ProtocolError`.
 *
 * Electron prefixes `invoke` rejections with the channel name, so the encoded
 * marker may not be at the start of the message; search for it anywhere.
 * Returns null when the message was not produced by `encodeProtocolError`.
 */
export function decodeProtocolError(message: string): ProtocolError | null {
  const prefixIndex = message.indexOf(PROTOCOL_ERROR_PREFIX)
  if (prefixIndex === -1) return null
  const remainder = message.slice(prefixIndex + PROTOCOL_ERROR_PREFIX.length)
  const separator = remainder.indexOf('::')
  if (separator === -1) return null
  const code = remainder.slice(0, separator)
  const output = remainder.slice(separator + 2)
  if (!SUPPORTED_CODES.has(code)) return null
  return new ProtocolError(code as ProtocolErrorCode, output || code)
}

/**
 * Coerce an unknown caught value into a `ProtocolError`, preserving a typed
 * code whenever one is recoverable. Returns an INTERNAL ProtocolError otherwise.
 */
export function toProtocolError(value: unknown): ProtocolError {
  if (value instanceof ProtocolError) return value
  if (value instanceof Error) {
    const decoded = decodeProtocolError(value.message)
    if (decoded) return decoded
    return new ProtocolError(ProtocolErrorCode.INTERNAL, value.message)
  }
  return new ProtocolError(ProtocolErrorCode.INTERNAL, 'Unexpected failure')
}
