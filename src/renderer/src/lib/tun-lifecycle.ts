import type { TunStatus } from '@shared/tun'

/**
 * Pure lifecycle gating for the TUN status/error UI. This encodes the
 * coordinator's allow-set (see `src/main/tun/state-machine.ts`) purely from the
 * reported status, so the component never has to reason about transitions and
 * the security boundary (which phases may start / may stop an owned adapter) is
 * directly unit-testable without mounting Vue.
 */
export interface TunLifecycleGating {
  active: boolean
  busyPhase: boolean
  canEnable: boolean
  canDisable: boolean
  showConflict: boolean
  showError: boolean
  showUnsupported: boolean
  enableLabel: string
}

export function tunLifecycleGating(status: TunStatus, busy: boolean): TunLifecycleGating {
  const phase = status.phase
  const supported = status.supported
  // Display "处理中"/"恢复中" while the coordinator is mid-transition OR a UI
  // action is in flight. Buttons are gated ONLY by the in-flight `busy` flag so a
  // rollback stays available during `starting`/`restoring` (the state machine
  // permits disable from both).
  const busyPhase = phase === 'starting' || phase === 'restoring' || busy

  // Enable is only offered from a settled, supported lifecycle. For a `failed`
  // phase this doubles as the retry affordance.
  const canEnable = supported && !busy && (phase === 'configured' || phase === 'failed')
  // Disable/restore is offered while TUN owns networking or is mid-rollback.
  const canDisable = supported && !busy && (phase === 'active' || phase === 'starting' || phase === 'restoring' || phase === 'restore-failed')

  return {
    active: phase === 'active',
    busyPhase,
    canEnable,
    canDisable,
    showConflict: phase === 'conflict' && (status.conflictDetail != null || status.errorMessage != null),
    showError: (phase === 'failed' || phase === 'restore-failed') && (status.errorMessage != null || status.conflictDetail != null),
    showUnsupported: !supported,
    enableLabel: phase === 'failed' ? '重试启用' : '启用'
  }
}

/** The richest user-facing detail: a conflict detail wins over a plain error. */
export function tunLifecycleDetail(status: TunStatus): string | null {
  return status.conflictDetail ?? status.errorMessage
}
