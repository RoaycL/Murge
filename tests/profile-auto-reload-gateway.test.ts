import { describe, it, expect, vi } from 'vitest'
import { ProfileAutoReloadGateway } from '../src/main/profiles/profile-auto-reload-gateway'
import { FakeProfileGateway } from '../src/main/testing/fake-container'

/** Minimal profile meta for the fake gateway. */
function meta(id: string, name: string, active: boolean, index: number) {
  return { id, name, source: { type: 'file' as const }, size: index * 10, createdAt: index, updatedAt: index, active }
}

function gatewayWith(inner: FakeProfileGateway, autoActivateOnEdit = true) {
  const reload = vi.fn(async () => {})
  const gw = new ProfileAutoReloadGateway({ inner, reloader: { reload }, autoActivateOnEdit })
  return { gw, reload }
}

describe('ProfileAutoReloadGateway', () => {
  it('reloads when editing the currently-active profile, without re-activating', async () => {
    const inner = new FakeProfileGateway()
    inner.profiles.push({ meta: meta('p1', 'One', true, 0), document: 'proxies: []\n' })
    inner.profiles.push({ meta: meta('p2', 'Two', false, 1), document: 'proxies: []\n' })
    inner.activeIndex = 0
    const { gw, reload } = gatewayWith(inner)

    const result = await gw.editDocument('p1', [{ key: 'mode', value: 'rule' }])

    expect(reload).toHaveBeenCalledTimes(1)
    // Active profile unchanged, no separate activate mutation.
    expect(inner.activeIndex).toBe(0)
    expect(result.active).toBe(true)
  })

  it('auto-activates a non-active profile on edit then reloads', async () => {
    const inner = new FakeProfileGateway()
    inner.profiles.push({ meta: meta('p1', 'One', false, 0), document: 'proxies: []\n' })
    inner.profiles.push({ meta: meta('p2', 'Two', true, 1), document: 'proxies: []\n' })
    inner.activeIndex = 1
    const { gw, reload } = gatewayWith(inner)

    const result = await gw.editDocument('p1', [{ key: 'mode', value: 'rule' }])

    expect(reload).toHaveBeenCalledTimes(1)
    // The edited profile became the active one (save-as-apply), so the reload
    // observes the commit.
    expect(inner.activeIndex).toBe(0)
    expect(result.active).toBe(true)
  })

  it('does not auto-activate or reload a non-active edit when disabled', async () => {
    const inner = new FakeProfileGateway()
    inner.profiles.push({ meta: meta('p1', 'One', false, 0), document: 'proxies: []\n' })
    inner.profiles.push({ meta: meta('p2', 'Two', true, 1), document: 'proxies: []\n' })
    inner.activeIndex = 1
    const { gw, reload } = gatewayWith(inner, false)

    const result = await gw.editDocument('p1', [{ key: 'mode', value: 'rule' }])

    expect(reload).not.toHaveBeenCalled()
    expect(inner.activeIndex).toBe(1)
    expect(result.active).toBe(false)
  })

  it('reloads after an explicit activation', async () => {
    const inner = new FakeProfileGateway()
    inner.profiles.push({ meta: meta('p1', 'One', false, 0), document: 'proxies: []\n' })
    inner.activeIndex = -1
    const { gw, reload } = gatewayWith(inner)

    const result = await gw.activateProfile('p1')

    expect(reload).toHaveBeenCalledTimes(1)
    expect(inner.activeIndex).toBe(0)
    expect(result.active).toBe(true)
  })

  it('restores the previous active profile when applying an activation fails', async () => {
    const inner = new FakeProfileGateway()
    inner.profiles.push({ meta: meta('p1', 'One', true, 0), document: 'proxies: []\n' })
    inner.profiles.push({ meta: meta('p2', 'Two', false, 1), document: 'proxies: []\n' })
    inner.activeIndex = 0
    const reload = vi.fn(async (rollback?: () => Promise<void>) => {
      await rollback?.()
      throw new Error('replacement rejected')
    })
    const gw = new ProfileAutoReloadGateway({ inner, reloader: { reload }, autoActivateOnEdit: true })

    await expect(gw.activateProfile('p2')).rejects.toThrow('replacement rejected')
    expect(inner.activeIndex).toBe(0)
  })

  it('restores the prior YAML snapshot when applying an edit fails', async () => {
    const inner = new FakeProfileGateway()
    const original = 'mode: rule\nproxies: []\n'
    inner.profiles.push({ meta: meta('p1', 'One', true, 0), document: original })
    inner.activeIndex = 0
    inner.editDocument = vi.fn(async (id) => {
      const profile = await inner.getProfile(id)
      profile.document = 'mode: global\nproxies: []\n'
      return profile.meta
    })
    const reload = vi.fn(async (rollback?: () => Promise<void>) => {
      await rollback?.()
      throw new Error('replacement rejected')
    })
    const gw = new ProfileAutoReloadGateway({ inner, reloader: { reload }, autoActivateOnEdit: true })

    await expect(gw.editDocument('p1', [{ key: 'mode', value: 'global' }]))
      .rejects.toThrow('replacement rejected')
    expect(inner.profiles[0].document).toBe(original)
    expect(inner.activeIndex).toBe(0)
  })

  it('clears the active pointer when the first activated import cannot be applied', async () => {
    const inner = new FakeProfileGateway()
    const reload = vi.fn(async (rollback?: () => Promise<void>) => {
      await rollback?.()
      throw new Error('replacement rejected')
    })
    const gw = new ProfileAutoReloadGateway({ inner, reloader: { reload }, autoActivateOnEdit: true })

    await expect(gw.importProfile({
      name: 'First', document: 'proxies: []\n', source: { type: 'file' }, activate: true
    })).rejects.toThrow('replacement rejected')
    expect(inner.activeIndex).toBe(-1)
  })

  it('reloads an import only when activated', async () => {
    const inner = new FakeProfileGateway()
    const { gw, reload } = gatewayWith(inner)

    await gw.importProfile({ name: 'A', document: 'proxies: []\n', source: { type: 'file' }, activate: true })
    expect(reload).toHaveBeenCalledTimes(1)

    await gw.importProfile({ name: 'B', document: 'proxies: []\n', source: { type: 'file' }, activate: false })
    expect(reload).toHaveBeenCalledTimes(1)

    await gw.importFromUrl('C', 'https://example.invalid/sub', true)
    expect(reload).toHaveBeenCalledTimes(2)

    await gw.importFromUrl('D', 'https://example.invalid/sub', false)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('reloads the strict fallback after deleting the active profile', async () => {
    const inner = new FakeProfileGateway()
    inner.profiles.push({ meta: meta('p1', 'One', true, 0), document: 'proxies: []\n' })
    inner.activeIndex = 0
    const { gw, reload } = gatewayWith(inner)

    await gw.listProfiles()
    await gw.getProfile('p1')
    await gw.renameProfile('p1', 'Renamed')
    gw.validateDocument('proxies: []\n')

    expect(reload).not.toHaveBeenCalled()
    expect(inner.profiles[0].meta.name).toBe('Renamed')

    await gw.deleteProfile('p1')
    expect(inner.profiles.length).toBe(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  describe('updateFromSource (subscription update)', () => {
    it('reloads when updating the ACTIVE profile and preserves the pointer', async () => {
      const inner = new FakeProfileGateway()
      inner.profiles.push({
        meta: { ...meta('p1', 'Sub', true, 0), source: { type: 'url' as const, url: 'https://example.invalid/sub' } },
        document: 'proxies:\n  - name: node\n    server: 127.0.0.1\n'
      })
      inner.activeIndex = 0
      const { gw, reload } = gatewayWith(inner)

      const result = await gw.updateFromSource('p1')

      expect(reload).toHaveBeenCalledTimes(1)
      expect(inner.activeIndex).toBe(0)
      expect(result.active).toBe(true)
      // The fake swaps the document so the update is observable.
      expect(inner.profiles[0].document).toContain('node-updated')
    })

    it('updates a NON-active profile without touching the kernel or pointer', async () => {
      const inner = new FakeProfileGateway()
      inner.profiles.push({
        meta: { ...meta('p1', 'Sub', false, 0), source: { type: 'url' as const, url: 'https://example.invalid/sub' } },
        document: 'proxies:\n  - name: node\n    server: 127.0.0.1\n'
      })
      inner.profiles.push({ meta: meta('p2', 'Other', true, 1), document: 'proxies: []\n' })
      inner.activeIndex = 1
      const { gw, reload } = gatewayWith(inner)

      await gw.updateFromSource('p1')

      expect(reload).not.toHaveBeenCalled()
      expect(inner.activeIndex).toBe(1)
      expect(inner.profiles[0].document).toContain('node-updated')
    })

    it('rolls the document back when the post-update reload fails', async () => {
      const inner = new FakeProfileGateway()
      inner.profiles.push({
        meta: { ...meta('p1', 'Sub', true, 0), source: { type: 'url' as const, url: 'https://example.invalid/sub' } },
        document: 'proxies:\n  - name: node\n    server: 127.0.0.1\n'
      })
      inner.activeIndex = 0
      const reload = vi.fn(async (rollback?: () => Promise<void>) => {
        try {
          throw new Error('kernel restart failed')
        } catch (error) {
          // The reloader contract: the rollback runs before the failure
          // propagates (reloadKernelForActiveProfile does this in production).
          await rollback?.()
          throw error
        }
      })
      const gw = new ProfileAutoReloadGateway({ inner, reloader: { reload }, autoActivateOnEdit: true })

      await expect(gw.updateFromSource('p1')).rejects.toThrow('kernel restart failed')
      // The rollback restored the pre-update snapshot.
      expect(inner.profiles[0].document).toContain('name: node\n')
      expect(inner.profiles[0].document).not.toContain('node-updated')
      expect(inner.activeIndex).toBe(0)
    })
  })
})
