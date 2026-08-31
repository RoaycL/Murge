import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { RC_EXCLUDED_FEATURES, RC_SUPPORTED_ROUTES, isRcSupportedRoute } from '../src/shared/release-scope'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('release-candidate feature scope', () => {
  it('freezes a unique allowlist and rejects unsupported routes', () => {
    expect(new Set(RC_SUPPORTED_ROUTES).size).toBe(RC_SUPPORTED_ROUTES.length)
    expect(RC_SUPPORTED_ROUTES).toContain('/activity')
    for (const route of ['/capture', '/decrypt', '/rewrite', '/panel']) {
      expect(isRcSupportedRoute(route)).toBe(false)
    }
    expect(RC_EXCLUDED_FEATURES.map(({ id }) => id)).toContain('tun')
  })

  it('does not expose excluded Surge-like pages in navigation or router imports', async () => {
    const [sidebar, router, overview] = await Promise.all([
      readFile(path.join(root, 'src/renderer/src/components/AppSidebar.vue'), 'utf8'),
      readFile(path.join(root, 'src/renderer/src/router.ts'), 'utf8'),
      readFile(path.join(root, 'src/renderer/src/views/OverviewView.vue'), 'utf8')
    ])
    for (const route of ['/capture', '/decrypt', '/rewrite', '/panel']) {
      expect(sidebar).not.toContain(route)
      expect(router).not.toContain(`path: '${route}'`)
    }
    expect(overview).not.toContain('toggleTun')
    expect(overview).not.toContain('TUN 模式')
  })
})
