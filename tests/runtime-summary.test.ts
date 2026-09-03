import { describe, it, expect } from 'vitest'
import { buildRuntimeSummary } from '../src/main/ipc/register-ipc'
import { brand } from '../src/shared/brand'
import { createFakeContainer } from '../src/main/testing/fake-container'

/**
 * `buildRuntimeSummary` is the main-process source of the Activity page's
 * context line. It must reflect REAL lifecycle owners (active profile name,
 * system-proxy phase, TUN phase) instead of placeholders — the review that
 * flagged this found the summary hardcoding `profileName` while the deps
 * already carried every real source.
 */
describe('buildRuntimeSummary real sources', () => {
  it('reports the ACTIVE profile name instead of the brand default', async () => {
    const container = createFakeContainer(brand)
    container.profiles.profiles = [
      {
        meta: {
          id: 'p1', name: '我的订阅', size: 10, createdAt: 1, updatedAt: 1,
          source: { type: 'url', url: 'https://example.invalid/sub', expire: null, usage: null }
        },
        document: 'mode: rule\n'
      },
      {
        meta: {
          id: 'p2', name: '备用订阅', size: 10, createdAt: 2, updatedAt: 2,
          source: { type: 'url', url: 'https://example.invalid/sub2', expire: null, usage: null }
        },
        document: 'mode: rule\n'
      }
    ]
    container.profiles.activeIndex = 1
    const summary = await buildRuntimeSummary(container.deps)
    expect(summary.profileName).toBe('备用订阅')
    expect(summary.profileName).not.toBe(brand.defaultProfileName)
  })

  it('falls back to the brand default when nothing is activated or the repository errors', async () => {
    const container = createFakeContainer(brand)
    const none = await buildRuntimeSummary(container.deps)
    expect(none.profileName).toBe(brand.defaultProfileName)

    const broken = createFakeContainer(brand)
    broken.profiles.listProfiles = async () => {
      throw new Error('repository unavailable')
    }
    const degraded = await buildRuntimeSummary(broken.deps)
    expect(degraded.profileName).toBe(brand.defaultProfileName)
  })

  it('reflects the system-proxy phase from the real lifecycle owner', async () => {
    const container = createFakeContainer(brand)
    container.systemProxy.status = {
      ...container.systemProxy.status,
      phase: 'enabled'
    }
    const summary = await buildRuntimeSummary(container.deps)
    expect(summary.systemProxyEnabled).toBe(true)

    const off = createFakeContainer(brand)
    const disabled = await buildRuntimeSummary(off.deps)
    expect(disabled.systemProxyEnabled).toBe(false)
  })

  it('reflects the TUN phase (active or starting) from the real lifecycle owner', async () => {
    const container = createFakeContainer(brand)
    container.tun.status = { ...container.tun.status, phase: 'active' }
    expect((await buildRuntimeSummary(container.deps)).tunEnabled).toBe(true)

    container.tun.status = { ...container.tun.status, phase: 'starting' }
    expect((await buildRuntimeSummary(container.deps)).tunEnabled).toBe(true)

    container.tun.status = { ...container.tun.status, phase: 'configured' }
    expect((await buildRuntimeSummary(container.deps)).tunEnabled).toBe(false)
  })

  it('keeps the summary intact when a status source throws', async () => {
    const container = createFakeContainer(brand)
    container.tun.getStatus = () => {
      throw new Error('tun status exploded')
    }
    const summary = await buildRuntimeSummary(container.deps)
    expect(summary.tunEnabled).toBe(false)
    expect(summary.profileName).toBe(brand.defaultProfileName)
    expect(summary.mode).toBe('rule')
  })
})
