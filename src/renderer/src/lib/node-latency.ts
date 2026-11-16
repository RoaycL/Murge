import { t } from '@shared/i18n'
import type { DelayNodeState } from '../stores/policies'

export interface LatencyLabel {
  text: string
  /** CSS modifier: ok | testing | timeout | idle. */
  kind: string
}

/**
 * Card text for a latency probe. A Tailscale node without an exit node only
 * reaches the tailnet, so the public-URL test always fails; show that instead
 * of a timeout.
 */
export function latencyLabel(state: DelayNodeState, tailscale: boolean, idleText = t('nodeLatency.selectToTest')): LatencyLabel {
  if (tailscale && (state.status === 'timeout' || state.status === 'unavailable' || state.status === 'error')) {
    return { text: t('nodeLatency.tailnetOnly'), kind: 'idle' }
  }
  switch (state.status) {
    case 'testing':
      return { text: t('nodeLatency.testing'), kind: 'testing' }
    case 'ok':
      return { text: `${state.delay} ms`, kind: 'ok' }
    case 'timeout':
      return { text: t('common.timeout'), kind: 'timeout' }
    case 'unavailable':
      return { text: t('nodeLatency.unavailable'), kind: 'timeout' }
    case 'error':
      return { text: t('common.failed'), kind: 'timeout' }
    default:
      return { text: idleText, kind: 'idle' }
  }
}

export function latencyTitle(state: DelayNodeState, tailscale: boolean): string {
  if (tailscale && state.status !== 'ok' && state.status !== 'idle' && state.status !== 'testing') {
    return t('nodeLatency.tailnetOnlyHint')
  }
  if (state.kind === 'control') {
    const head = state.status === 'ok' ? t('nodeLatency.controlOk') : t('nodeLatency.controlFailed')
    return t('nodeLatency.controlDetail', [head, state.url ?? '', state.via ?? 'DIRECT', state.error ? t('common.colon') + state.error : ''])
  }
  if (state.error) return state.error
  return state.url ? t('nodeLatency.testUrl', [state.url]) : t('nodeLatency.testNode')
}
