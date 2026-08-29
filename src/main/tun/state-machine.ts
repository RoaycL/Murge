import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { TunIntent, TunPhase, TunStatus } from '../../shared/tun'

const TRANSITIONS: Readonly<Record<TunPhase, Partial<Record<TunIntent, TunPhase>>>> = {
  configured: { initialize: 'configured', enable: 'starting', unsupported: 'unsupported' },
  starting: { enabled: 'active', disable: 'restoring', fail: 'restoring', fatal: 'failed', conflict: 'conflict' },
  active: { disable: 'restoring', fail: 'restoring', fatal: 'failed', conflict: 'conflict' },
  restoring: { restored: 'configured', fail: 'restore-failed', conflict: 'conflict' },
  failed: { enable: 'starting', disable: 'restoring', unsupported: 'unsupported' },
  conflict: {},
  unsupported: { initialize: 'unsupported' },
  'restore-failed': { disable: 'restoring' }
}

export interface TunTransitionDetail {
  errorMessage?: string | null
  conflictDetail?: string | null
}

export function initialTunStatus(supported: boolean): TunStatus {
  return {
    supported,
    phase: supported ? 'configured' : 'unsupported',
    errorMessage: null,
    conflictDetail: null,
    updatedAt: null
  }
}

/** Pure transition function. It cannot activate a helper or mutate networking. */
export function transitionTunStatus(status: TunStatus, intent: TunIntent, detail: TunTransitionDetail = {}, now = new Date()): TunStatus {
  const next = TRANSITIONS[status.phase][intent]
  if (!next) {
    throw new ProtocolError(
      ProtocolErrorCode.TUN_INVALID_TRANSITION,
      `Invalid TUN transition: ${status.phase} + ${intent}`,
      { path: 'phase', reason: `${status.phase} cannot handle ${intent}` }
    )
  }
  if (next === 'conflict' && !detail.conflictDetail && !status.conflictDetail) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_ARGUMENT,
      'TUN conflict transition requires conflictDetail',
      { path: 'conflictDetail' }
    )
  }
  return {
    supported: next !== 'unsupported',
    phase: next,
    errorMessage: detail.errorMessage ?? (next === 'failed' || next === 'restore-failed' ? status.errorMessage : null),
    conflictDetail: next === 'conflict' ? (detail.conflictDetail ?? status.conflictDetail) : null,
    updatedAt: now.toISOString()
  }
}
