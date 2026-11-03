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
export function latencyLabel(state: DelayNodeState, tailscale: boolean, idleText = '选择测试'): LatencyLabel {
  if (tailscale && (state.status === 'timeout' || state.status === 'unavailable' || state.status === 'error')) {
    return { text: '仅 tailnet', kind: 'idle' }
  }
  switch (state.status) {
    case 'testing':
      return { text: '测试中…', kind: 'testing' }
    case 'ok':
      return { text: `${state.delay} ms`, kind: 'ok' }
    case 'timeout':
      return { text: '超时', kind: 'timeout' }
    case 'unavailable':
      return { text: '不可用', kind: 'timeout' }
    case 'error':
      return { text: '失败', kind: 'timeout' }
    default:
      return { text: idleText, kind: 'idle' }
  }
}

export function latencyTitle(state: DelayNodeState, tailscale: boolean): string {
  if (tailscale && state.status !== 'ok' && state.status !== 'idle' && state.status !== 'testing') {
    return '延迟测试访问的是公网地址；没有设置出口节点的 Tailscale 节点只能访问 tailnet，测不出延迟不代表不可用'
  }
  if (state.kind === 'control') {
    const head = state.status === 'ok' ? '没有出口节点，测的是到控制服务器的往返时间' : '没有出口节点，测的是控制服务器，连不上时节点无法登录'
    return `${head}（${state.url ?? ''}，经 ${state.via ?? 'DIRECT'}）${state.error ? `：${state.error}` : ''}`
  }
  if (state.error) return state.error
  return state.url ? `测试地址：${state.url}` : '测试此节点'
}
