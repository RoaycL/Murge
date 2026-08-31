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

  it('delegates non-mutating and unrelated mutating methods untouched', async () => {
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
  })
})
