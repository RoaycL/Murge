import { z } from 'zod'

const canonicalGuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const canonicalLuid = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/)
const nonNegativeInteger = z.number().int().nonnegative()

export const tunPhaseSchema = z.enum([
  'configured',
  'starting',
  'active',
  'restoring',
  'failed',
  'conflict',
  'unsupported',
  'restore-failed'
])

export const tunStatusSchema = z.object({
  supported: z.boolean(),
  phase: tunPhaseSchema,
  errorMessage: z.string().nullable(),
  conflictDetail: z.string().nullable(),
  updatedAt: z.string().datetime().nullable()
}).superRefine((value, context) => {
  if (value.phase === 'unsupported' && value.supported) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['supported'], message: 'unsupported phase requires supported=false' })
  }
  if (value.phase !== 'unsupported' && !value.supported) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['supported'], message: 'supported=false requires unsupported phase' })
  }
  if (value.phase === 'conflict' && !value.conflictDetail) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['conflictDetail'], message: 'conflict phase requires conflictDetail' })
  }
})

export const desiredNetworkStateSchema = z.object({
  schemaVersion: z.literal(1),
  adapter: z.object({
    name: z.string().trim().min(1).max(128),
    tunnelType: z.string().trim().min(1).max(128),
    requestedGuid: canonicalGuid
  }).strict(),
  routes: z.array(z.object({
    family: z.union([z.literal(4), z.literal(6)]),
    destination: z.string().ip(),
    prefixLength: nonNegativeInteger.max(128),
    nextHop: z.string().ip().nullable(),
    metric: nonNegativeInteger,
    routeStore: z.enum(['active', 'persistent'])
  }).strict().superRefine((route, context) => {
    const max = route.family === 4 ? 32 : 128
    if (route.prefixLength > max) context.addIssue({ code: z.ZodIssueCode.custom, path: ['prefixLength'], message: `IPv${route.family} prefix exceeds ${max}` })
    const expected = route.family === 4 ? '.' : ':'
    if (!route.destination.includes(expected) || (route.nextHop !== null && !route.nextHop.includes(expected))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'route addresses must match family' })
    }
  })),
  dns: z.array(z.object({
    luid: canonicalLuid,
    servers: z.array(z.string().ip()).min(1),
    source: z.enum(['static', 'dhcp'])
  }).strict()),
  metrics: z.array(z.object({ luid: canonicalLuid, metric: nonNegativeInteger }).strict())
}).strict()
