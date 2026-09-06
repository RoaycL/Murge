import { describe, expect, it, vi } from 'vitest'
import type { MihomoGateway } from '../src/shared/gateways'
import { EMPTY_TUN_CONFIG } from '../src/shared/tun-config'
import { MihomoHotSwitchTunAdapter } from '../src/main/tun/hot-switch-adapter'

function setup(initialTun: Record<string, unknown> = { enable: false, device: 'Product TUN', stack: 'mixed' }) {
  let tun = { ...initialTun }
  const patchConfig = vi.fn(async (patch: { tun?: Record<string, unknown> }) => {
    if (patch.tun) tun = { ...patch.tun }
  })
  const mihomo = {
    getConfig: vi.fn(async () => ({ 'mixed-port': 17890, tun: { ...tun } })),
    patchConfig
  } as unknown as MihomoGateway
  let finishProbe: (() => void) | null = null
  const readiness = vi.fn(() => new Promise<void>((resolve) => { finishProbe = resolve }))
  const adapter = new MihomoHotSwitchTunAdapter(
    mihomo,
    () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ab'.repeat(32) }),
    { waitUntilReady: readiness },
    () => ({ ...EMPTY_TUN_CONFIG }),
    5_000
  )
  return { adapter, patchConfig, readiness, finishProbe: () => finishProbe?.(), current: () => tun }
}

describe('persistent-core TUN hot switch', () => {
  it('enables and disables TUN without waiting for the public data-plane probe', async () => {
    const h = setup()
    await expect(h.adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' }))
      .resolves.toEqual({ outcome: 'active' })
    expect(h.current().enable).toBe(true)
    expect(h.readiness).toHaveBeenCalledOnce()
    await expect(h.adapter.restore()).resolves.toEqual({ outcome: 'restored' })
    expect(h.current().enable).toBe(false)
    h.finishProbe()
  })

  it('restores the exact previous TUN block when enable read-back fails', async () => {
    const previous = { enable: false, device: 'Old', stack: 'gvisor', custom: 'kept' }
    let reads = 0
    let tun = { ...previous }
    const mihomo = {
      getConfig: vi.fn(async () => {
        reads += 1
        return { tun: reads === 2 ? { ...tun, enable: false } : { ...tun } }
      }),
      patchConfig: vi.fn(async (patch: { tun?: Record<string, unknown> }) => { if (patch.tun) tun = { ...patch.tun } })
    } as unknown as MihomoGateway
    const adapter = new MihomoHotSwitchTunAdapter(
      mihomo,
      () => ({ mixedPort: 1, controllerPort: 2, secret: 'ab'.repeat(32) }),
      { waitUntilReady: vi.fn(async () => undefined) },
      () => ({ ...EMPTY_TUN_CONFIG })
    )
    const result = await adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })
    expect(result.outcome).toBe('rollback-required')
    expect(tun).toEqual(previous)
  })
})
