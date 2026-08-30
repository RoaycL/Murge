import { z } from 'zod'

const canonicalGuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const canonicalLuid = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/)
const nonNegativeInteger = z.number().int().nonnegative()
const safeAdapterLabel = z.string().trim().min(1).max(128).refine(
  value => !/[\u0000-\u001f\u007f]/.test(value),
  'adapter label contains a control character'
)

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
    name: safeAdapterLabel,
    tunnelType: safeAdapterLabel,
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
    servers: z.array(z.string().ip()).min(1).superRefine((servers, context) => {
      addDuplicateIssues(servers, server => server, context, 'duplicate DNS server')
    }),
    source: z.enum(['static', 'dhcp'])
  }).strict()),
  metrics: z.array(z.object({ luid: canonicalLuid, metric: nonNegativeInteger }).strict())
}).strict().superRefine((value, context) => {
  addDuplicateIssues(
    value.routes,
    route => [route.family, route.destination, route.prefixLength, route.nextHop ?? '', route.metric, route.routeStore].join('|'),
    context,
    'duplicate route',
    ['routes']
  )
  addDuplicateIssues(value.dns, item => item.luid, context, 'duplicate DNS target LUID', ['dns'])
  addDuplicateIssues(value.metrics, item => item.luid, context, 'duplicate metric target LUID', ['metrics'])

  const targetLuids = new Set([...value.dns.map(item => item.luid), ...value.metrics.map(item => item.luid)])
  if (targetLuids.size > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dns'],
      message: 'one DesiredNetworkState cannot target multiple adapter LUIDs'
    })
  }
})

export const mihomoOwnedTunIntentSchema = z.object({
  schemaVersion: z.literal(2),
  device: safeAdapterLabel.refine(value => /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value), 'device contains unsupported characters'),
  stack: z.enum(['mixed', 'system', 'gvisor'])
}).strict()

function addDuplicateIssues<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  context: z.RefinementCtx,
  message: string,
  pathPrefix: Array<string | number> = []
): void {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const key = keyOf(value)
    if (seen.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: [...pathPrefix, index], message })
    seen.add(key)
  })
}
