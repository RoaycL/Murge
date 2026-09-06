/**
 * Shared contract for the 网络诊断 drawer's common-service unlock tests
 * (参考 clash-verge-rev 的解锁测试页). The main process owns the probes; the
 * renderer only renders verdicts.
 */

/** One service's unlock verdict. `unsupported` = reachable but blocked for this egress. */
export interface ServiceUnlockResult {
  name: string
  status: 'supported' | 'unsupported' | 'error'
  /** Region marker extracted from the service response (e.g. US, KR, ALISG). */
  region: string | null
}

/** The preset services, in display order (AI → streaming → others). */
export const UNLOCK_SERVICES = [
  'ChatGPT',
  'Gemini',
  'Claude',
  'Grok',
  'Netflix',
  'Disney+',
  'TikTok',
  'YouTube',
  'GitHub',
  'Spotify'
] as const

export type UnlockServiceName = (typeof UNLOCK_SERVICES)[number]
