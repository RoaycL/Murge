/**
 * Frozen feature surface for the first release candidate.
 *
 * This is deliberately data, not scattered renderer conditionals. Pages that
 * look actionable but do not have a completed backend must not ship in the
 * navigation or remain reachable through a hand-written hash route.
 */
export const RC_SUPPORTED_ROUTES = [
  '/activity',
  '/overview',
  '/connections',
  '/processes',
  '/devices',
  '/policies',
  '/rules',
  '/config',
  '/providers',
  '/more',
  '/general',
  '/appearance',
  '/dns',
  '/logs',
  '/about'
] as const

export type RcSupportedRoute = (typeof RC_SUPPORTED_ROUTES)[number]

export const RC_EXCLUDED_FEATURES = Object.freeze([
  { id: 'tun', reason: 'G1 real Windows reuse/recovery gate is not proven' },
  { id: 'http-capture', reason: 'no completed mihomo transport and persistence contract' },
  { id: 'https-decryption', reason: 'no certificate lifecycle or trusted interception implementation' },
  { id: 'rewrite', reason: 'no completed rewrite backend' },
  { id: 'panel', reason: 'placeholder-only Surge-like page' },
  { id: 'automatic-updates', reason: 'release signer and update channel are not configured' }
] as const)

export function isRcSupportedRoute(path: string): path is RcSupportedRoute {
  return (RC_SUPPORTED_ROUTES as readonly string[]).includes(path)
}
