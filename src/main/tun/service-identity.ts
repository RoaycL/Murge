import { createHash } from 'node:crypto'

/** Stable across product-name changes as long as the durable appId is retained. */
export function tunServiceIdentity(appId: string): { serviceName: string; pipeName: string; namespaceId: string } {
  const suffix = createHash('sha256').update(appId, 'utf8').digest('hex').slice(0, 16)
  return {
    serviceName: `ProxyDesktopTun_${suffix}`,
    pipeName: `proxy-desktop-tun-${suffix}`,
    namespaceId: `proxy-desktop-${suffix}`
  }
}
