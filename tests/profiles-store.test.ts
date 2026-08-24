import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProfilesStore } from '../src/renderer/src/stores/profiles'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'
import type { ProfileMeta } from '../src/shared/profiles'

const ACTIVE_META: ProfileMeta = {
  id: 'p1',
  name: '主配置',
  source: { type: 'url', url: 'https://redacted@example.com/x' },
  size: 42,
  createdAt: 100,
  updatedAt: 100,
  active: true
}

const INACTIVE_META: ProfileMeta = {
  id: 'p2',
  name: '备用',
  source: { type: 'manual' },
  size: 10,
  createdAt: 50,
  updatedAt: 50,
  active: false
}

function installWindow(gateway: Record<string, ReturnType<typeof vi.fn>>): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    desktop: { profiles: gateway }
  }
}

describe('profiles store', () => {
  let list: ReturnType<typeof vi.fn>
  let get: ReturnType<typeof vi.fn>
  let importProfile: ReturnType<typeof vi.fn>
  let importFromUrl: ReturnType<typeof vi.fn>
  let activate: ReturnType<typeof vi.fn>
  let remove: ReturnType<typeof vi.fn>
  let rename: ReturnType<typeof vi.fn>
  let editDocument: ReturnType<typeof vi.fn>
  let validate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    list = vi.fn()
    get = vi.fn()
    importProfile = vi.fn()
    importFromUrl = vi.fn()
    activate = vi.fn()
    remove = vi.fn()
    rename = vi.fn()
    editDocument = vi.fn()
    validate = vi.fn()
    importFromUrl.mockResolvedValue(ACTIVE_META)
    list.mockResolvedValue([INACTIVE_META, ACTIVE_META])
    get.mockResolvedValue(null)
    installWindow({ list, get, import: importProfile, importFromUrl, activate, delete: remove, rename, editDocument, validate })
  })

  afterEach(() => {
    ;(globalThis as unknown as { window: unknown }).window = undefined
  })

  it('load populates profiles and selects the active id', async () => {
    const store = useProfilesStore()
    await store.load()
    expect(store.status).toBe('ready')
    expect(store.profiles).toHaveLength(2)
    expect(store.currentId).toBe('p1')
    expect(store.active?.name).toBe('主配置')
  })

  it('surfaces a load failure without leaving stale data', async () => {
    list.mockRejectedValue(new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'boom'))
    const store = useProfilesStore()
    await store.load()
    expect(store.status).toBe('error')
    expect(store.lastError).toContain('boom')
    expect(store.profiles).toEqual([])
  })

  it('importFromUrl delegates and reloads the list', async () => {
    const store = useProfilesStore()
    await store.importFromUrl('sub', 'https://x', true)
    expect(importFromUrl).toHaveBeenCalledWith('sub', 'https://x', true)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('activate surfaces an error and rethrows', async () => {
    activate.mockRejectedValue(new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, '配置校验失败'))
    const store = useProfilesStore()
    await expect(store.activate('p2')).rejects.toThrow(/配置校验失败/)
    expect(store.lastError).toContain('配置校验失败')
  })

  it('editDocument applies edits and refreshes the detail', async () => {
    const store = useProfilesStore()
    await store.editDocument('p1', [{ key: 'mode', value: 'global' }])
    expect(editDocument).toHaveBeenCalledWith('p1', [{ key: 'mode', value: 'global' }])
    expect(list).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('p1')
  })

  it('validate returns the gateway result', async () => {
    validate.mockResolvedValue({ ok: true, issues: [] })
    const store = useProfilesStore()
    const result = await store.validate('proxies: []\n')
    expect(result.ok).toBe(true)
    expect(validate).toHaveBeenCalledWith('proxies: []\n')
  })

  it('validate coerces a gateway failure into a failed result', async () => {
    validate.mockRejectedValue(new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'bad'))
    const store = useProfilesStore()
    const result = await store.validate('x')
    expect(result.ok).toBe(false)
    expect(result.issues[0].severity).toBe('error')
  })

  it('clear resets all state', async () => {
    const store = useProfilesStore()
    await store.load()
    store.clear()
    expect(store.profiles).toEqual([])
    expect(store.currentId).toBe(null)
    expect(store.status).toBe('idle')
  })
})
