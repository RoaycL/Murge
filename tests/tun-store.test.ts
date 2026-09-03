import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TunStatus } from '../src/shared/tun'
import { useTunStore } from '../src/renderer/src/stores/tun'

const configured: TunStatus = { supported: true, phase: 'configured', errorMessage: null, conflictDetail: null, updatedAt: '2026-01-01T00:00:00.000Z' }
const active: TunStatus = { supported: true, phase: 'active', errorMessage: null, conflictDetail: null, updatedAt: '2026-01-01T00:00:01.000Z' }

const getStatus = vi.fn()
const enable = vi.fn()
const disable = vi.fn()
const onStatus = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { desktop: { tun: { getStatus, enable, disable, onStatus } } }
})
afterEach(() => { ;(globalThis as unknown as { window?: unknown }).window = undefined })

describe('TUN lifecycle store', () => {
  it('pulls the coordinator status on refresh', async () => {
    getStatus.mockResolvedValue(configured)
    const store = useTunStore()
    await store.refresh()
    expect(getStatus).toHaveBeenCalledOnce()
    expect(store.status.phase).toBe('configured')
    expect(store.actionError).toBe('')
  })

  it('records an action error when enable rejects', async () => {
    getStatus.mockResolvedValue(configured)
    enable.mockRejectedValue(new Error('kernel not running'))
    const store = useTunStore()
    await store.refresh()
    await store.enable()
    expect(enable).toHaveBeenCalledOnce()
    expect(store.actionError).toBe('kernel not running')
    expect(store.busy).toBe(false)
  })

  it('toggles busy while an action is in flight', async () => {
    getStatus.mockResolvedValue(configured)
    let resolveEnable: (value: TunStatus) => void = () => {}
    enable.mockReturnValue(new Promise((resolve) => { resolveEnable = resolve }))
    const store = useTunStore()
    const pending = store.enable()
    expect(store.busy).toBe(true)
    resolveEnable(active)
    await pending
    expect(store.busy).toBe(false)
    expect(store.status.phase).toBe('active')
  })

  it('records an action error when disable rejects', async () => {
    getStatus.mockResolvedValue(active)
    disable.mockRejectedValue(new Error('restore failed'))
    const store = useTunStore()
    await store.refresh()
    await store.disable()
    expect(disable).toHaveBeenCalledOnce()
    expect(store.actionError).toBe('restore failed')
  })

  it('subscribes to status events and clears the committed action error', async () => {
    getStatus.mockResolvedValue(configured)
    onStatus.mockReturnValue(() => {})
    const store = useTunStore()
    store.connect()
    expect(onStatus).toHaveBeenCalledOnce()
    const listener = onStatus.mock.calls[0][0] as (status: TunStatus) => void
    store.actionError = 'stale'
    listener(active)
    expect(store.status).toEqual(active)
    expect(store.actionError).toBe('')
    store.disconnect()
    expect(onStatus.mock.results[0].value).toBeTypeOf('function')
  })
})
