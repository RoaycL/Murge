import { describe, expect, it, vi } from 'vitest'
import type { MihomoGateway } from '../src/shared/gateways'
import { EMPTY_TUN_CONFIG } from '../src/shared/tun-config'
import { MihomoHotSwitchTunAdapter } from '../src/main/tun/hot-switch-adapter'

type Gateway = {
  gateway: MihomoGateway
  patchConfig: ReturnType<typeof vi.fn>
  current: () => Record<string, unknown>
}

function buildGateway(initialTun: Record<string, unknown> = { enable: false, device: 'Product TUN', stack: 'mixed' }): Gateway {
  let tun = { ...initialTun }
  const patchConfig = vi.fn(async (patch: { tun?: Record<string, unknown> }) => {
    if (patch.tun) tun = { ...patch.tun }
  })
  const gateway = {
    getConfig: vi.fn(async () => ({ 'mixed-port': 17890, tun: { ...tun } })),
    patchConfig
  } as unknown as MihomoGateway
  return { gateway, patchConfig, current: () => tun }
}

function setup(initialTun: Record<string, unknown> = { enable: false, device: 'Product TUN', stack: 'mixed' }) {
  const built = buildGateway(initialTun)
  let finishProbe: (() => void) | null = null
  const readiness = vi.fn(() => new Promise<void>((resolve) => { finishProbe = resolve }))
  const adapter = new MihomoHotSwitchTunAdapter(
    built.gateway,
    () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ab'.repeat(32) }),
    { waitUntilReady: readiness },
    () => ({ ...EMPTY_TUN_CONFIG }),
    5_000
  )
  return { adapter, patchConfig: built.patchConfig, readiness, finishProbe: () => finishProbe?.(), current: built.current }
}

/**
 * Same harness but with the authoritative dns-enabled flag injected — the
 * constructor slot the app uses to feed the ACTIVE document's DNS state.
 */
function setupWithDnsFlag(readDnsEnabled: () => boolean) {
  const built = buildGateway()
  const adapter = new MihomoHotSwitchTunAdapter(
    built.gateway,
    () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ab'.repeat(32) }),
    { waitUntilReady: vi.fn(async () => undefined) },
    () => ({ ...EMPTY_TUN_CONFIG }),
    5_000,
    readDnsEnabled
  )
  return { adapter, current: built.current }
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
    const gateway = {
      getConfig: vi.fn(async () => {
        reads += 1
        return { tun: reads === 2 ? { ...tun, enable: false } : { ...tun } }
      }),
      patchConfig: vi.fn(async (patch: { tun?: Record<string, unknown> }) => { if (patch.tun) tun = { ...patch.tun } })
    } as unknown as MihomoGateway
    const adapter = new MihomoHotSwitchTunAdapter(
      gateway,
      () => ({ mixedPort: 1, controllerPort: 2, secret: 'ab'.repeat(32) }),
      { waitUntilReady: vi.fn(async () => undefined) },
      () => ({ ...EMPTY_TUN_CONFIG })
    )
    const result = await adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })
    expect(result.outcome).toBe('rollback-required')
    expect(tun).toEqual(previous)
  })

  it('keeps dns-hijack when the active document enables DNS', async () => {
    const h = setupWithDnsFlag(() => true)
    await h.adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })
    expect(h.current().enable).toBe(true)
    expect(h.current()['dns-hijack']).toEqual(['any:53'])
  })

  it('clears dns-hijack when the active document has no enabled DNS (clash-party parity)', async () => {
    const h = setupWithDnsFlag(() => false)
    await h.adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })
    expect(h.current().enable).toBe(true)
    expect(h.current()['dns-hijack']).toEqual([])
  })
})
