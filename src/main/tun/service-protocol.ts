import { createHash } from 'node:crypto'
import { z } from 'zod'
import { assertMihomoTunConfig } from './mihomo-tun-config'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

export const TUN_SERVICE_PROTOCOL_VERSION = 2 as const
export const TUN_SERVICE_MAX_PROFILE_BYTES = 64 * 1024

const uint64Decimal = z.string().regex(/^(?:0|[1-9]\d{0,19})$/).refine(value => BigInt(value) <= 0xffffffffffffffffn)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const sessionId = z.string().uuid()

export const tunServiceRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    protocolVersion: z.literal(TUN_SERVICE_PROTOCOL_VERSION),
    requestId: uint64Decimal,
    operation: z.literal('start'),
    sessionId,
    profile: z.string().min(1).max(TUN_SERVICE_MAX_PROFILE_BYTES),
    profileSha256: sha256
  }).strict(),
  z.object({
    protocolVersion: z.literal(TUN_SERVICE_PROTOCOL_VERSION),
    requestId: uint64Decimal,
    operation: z.literal('stop'),
    sessionId
  }).strict(),
  z.object({
    protocolVersion: z.literal(TUN_SERVICE_PROTOCOL_VERSION),
    requestId: uint64Decimal,
    operation: z.literal('status')
  }).strict(),
  z.object({
    protocolVersion: z.literal(TUN_SERVICE_PROTOCOL_VERSION),
    requestId: uint64Decimal,
    operation: z.literal('reconcile')
  }).strict()
])

export type TunServiceRequest = z.infer<typeof tunServiceRequestSchema>

export const tunServiceResponseSchema = z.object({
  protocolVersion: z.literal(TUN_SERVICE_PROTOCOL_VERSION),
  requestId: uint64Decimal,
  outcome: z.enum(['stopped', 'starting', 'running', 'stopping', 'failed', 'conflict']),
  sessionId: sessionId.nullable(),
  pid: z.number().int().positive().nullable(),
  errorCode: z.string().regex(/^[A-Z0-9_]+$/).nullable()
}).strict().superRefine((value, context) => {
  const ownsChild = value.outcome === 'starting' || value.outcome === 'running' || value.outcome === 'stopping'
  if (ownsChild && (value.sessionId === null || value.pid === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${value.outcome} requires sessionId and pid` })
  }
  if (value.outcome === 'stopped' && (value.sessionId !== null || value.pid !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'stopped must not retain process ownership' })
  }
})

export type TunServiceResponse = z.infer<typeof tunServiceResponseSchema>

/** Validate the privileged boundary request, including exact profile digest/content. */
export function parseTunServiceRequest(input: unknown): TunServiceRequest {
  const request = tunServiceRequestSchema.parse(input)
  if (request.operation === 'start') {
    if (Buffer.byteLength(request.profile, 'utf8') > TUN_SERVICE_MAX_PROFILE_BYTES) fail('profile exceeds byte limit')
    const digest = createHash('sha256').update(request.profile, 'utf8').digest('hex')
    if (digest !== request.profileSha256) fail('profile digest mismatch')
    assertMihomoTunConfig(request.profile)
  }
  return request
}

export function parseTunServiceResponse(input: unknown, expectedRequestId: string): TunServiceResponse {
  const response = tunServiceResponseSchema.parse(input)
  if (response.requestId !== expectedRequestId) fail('response requestId mismatch')
  return response
}

function fail(reason: string): never {
  throw new ProtocolError(ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID, 'Invalid TUN service protocol message', { reason })
}
