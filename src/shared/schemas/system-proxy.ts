import { z } from 'zod'
import type { SystemProxyStatus } from '../system-proxy'

/**
 * Schema for the value returned to the renderer over the system-proxy IPC
 * channels. `enable`/`disable` take no arguments; the only cross-boundary value
 * is the status, which the main process validates before emitting.
 */
export const systemProxyStatusSchema = z.object({
  supported: z.boolean(),
  phase: z.enum([
    'disabled',
    'enabling',
    'enabled',
    'restoring',
    'restore-failed',
    'conflict',
    'unsupported'
  ]),
  address: z.string().nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  errorMessage: z.string().nullable(),
  conflictDetail: z.string().nullable(),
  updatedAt: z.string().nullable()
})

/**
 * Validate a status object and return a normalized copy. Throws when the shape
 * drifts from the contract so a malformed status never reaches the renderer.
 */
export function parseSystemProxyStatus(input: unknown): SystemProxyStatus {
  return systemProxyStatusSchema.parse(input) as SystemProxyStatus
}
