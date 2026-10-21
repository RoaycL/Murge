import { describe, expect, it, vi } from 'vitest'
import type { MihomoGateway } from '../src/shared/gateways'
import { EMPTY_TUN_CONFIG } from '../src/shared/tun-config'
import type { TunConfigModel } from '../src/shared/tun-config'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '../src/shared/system-proxy'
import { ProtocolErrorCode } from '../src/shared/protocol-errors'
import { isIgnoredInterfaceName } from '../src/main/services/network-detector'
import { MihomoHotSwitchTunAdapter } from '../src/main/tun/hot-switch-adapter'
import { TunCoordinator, type TunMutationAdapter } from '../src/main/tun/coordinator'
import { SystemProxyService } from '../src/main/system-proxy/service'
import { StaticSystemProxyProbe } from '../src/main/system-proxy/probe'
import { FakeSystemProxyAdapter } from '../src/main/system-proxy/adapters/fake-adapter'
import { InMemorySystemProxyBackupStore } from '../src/main/system-proxy/backup-store'
import type { SystemProxyBackup } from '../src/main/system-proxy/types'

describe('network detector interface filter', () => {
  it('keeps real adapters whose names merely contain "lo"', () => {
    expect(isIgnoredInterfaceName('Local Area Connection')).toBe(false)
    expect(isIgnoredInterfaceName('Local Area Connection 2')).toBe(false)
    expect(isIgnoredInterfaceName('以太网')).toBe(false)
    expect(isIgnoredInterfaceName('WLAN')).toBe(false)
  })

  it('still ignores loopback and virtual adapters', () => {
    for (const name of ['lo', 'lo0', 'Mihomo', 'docker0', 'vEthernet (WSL)', 'VMware Network Adapter VMnet8', 'utun3']) {
      expect(isIgnoredInterfaceName(name)).toBe(true)
    }
  })
})

function hotSwitch(initialTun: Record<string, unknown>, model: () => TunConfigModel) {
  let tun = { ...initialTun }
  const patchConfig = vi.fn(async (patch: { tun?: Record<string, unknown> }) => {
    // mihomo's PATCH keeps omitted keys.
    if (patch.tun) tun = { ...tun, ...patch.tun }
  })
  const gateway = {
    getConfig: vi.fn(async () => ({ 'mixed-port': 17890, tun: { ...tun } })),
    patchConfig
  } as unknown as MihomoGateway
  const adapter = new MihomoHotSwitchTunAdapter(
    gateway,
    () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ab'.repeat(32) }),
    { waitUntilReady: vi.fn(async () => undefined) },
    model,
    5_000
  )
  return { adapter, patchConfig, current: () => tun }
}

describe('TUN hot switch route lists and live re-apply', () => {
  it('clears route lists that were removed from settings', async () => {
    const h = hotSwitch(
      { enable: false, device: 'Mihomo', 'route-address': ['10.0.0.0/8'], 'route-exclude-address': ['192.168.0.0/16'] },
      () => ({ ...EMPTY_TUN_CONFIG })
    )
    const result = await h.adapter.enable({ schemaVersion: 2, device: 'Mihomo', stack: 'mixed' })
    expect(result.outcome).toBe('active')
    expect(h.current()['route-address']).toEqual([])
    expect(h.current()['route-exclude-address']).toEqual([])
  })

  it('pushes edited settings to an active TUN', async () => {
    let model: TunConfigModel = { ...EMPTY_TUN_CONFIG }
    const h = hotSwitch({ enable: false, device: 'Mihomo' }, () => model)
    await h.adapter.enable({ schemaVersion: 2, device: 'Mihomo', stack: 'mixed' })
    model = { ...model, mtu: 1400, stack: 'gvisor' }
    await h.adapter.reapply()
    expect(h.current()).toMatchObject({ enable: true, mtu: 1400, stack: 'gvisor' })
  })

  it('refuses a device rename while active instead of bypassing the in-use guard', async () => {
    let model: TunConfigModel = { ...EMPTY_TUN_CONFIG }
    const h = hotSwitch({ enable: false, device: 'Mihomo' }, () => model)
    await h.adapter.enable({ schemaVersion: 2, device: 'Mihomo', stack: 'mixed' })
    h.patchConfig.mockClear()
    model = { ...model, device: 'OtherTun' }
    await expect(h.adapter.reapply()).rejects.toThrow('关闭 TUN')
    expect(h.patchConfig).not.toHaveBeenCalled()
    expect(h.current().device).toBe('Mihomo')
  })

  it('does nothing before TUN was enabled', async () => {
    const h = hotSwitch({ enable: false, device: 'Mihomo' }, () => ({ ...EMPTY_TUN_CONFIG }))
    await h.adapter.reapply()
    expect(h.patchConfig).not.toHaveBeenCalled()
  })
})

describe('TunCoordinator.reapplyConfig', () => {
  function adapter(reapply: () => Promise<void>): TunMutationAdapter {
    return {
      recoveryRequired: vi.fn(async () => false),
      enable: vi.fn(async () => ({ outcome: 'active' as const })),
      restore: vi.fn(async () => ({ outcome: 'restored' as const })),
      reapply: vi.fn(reapply)
    }
  }
  const intent = { schemaVersion: 2, device: 'Mihomo', stack: 'mixed' } as const

  it('only re-applies while active', async () => {
    const a = adapter(async () => undefined)
    const coordinator = new TunCoordinator(a, true)
    await coordinator.reapplyConfig()
    expect(a.reapply).not.toHaveBeenCalled()
    await coordinator.enable(intent)
    await coordinator.reapplyConfig()
    expect(a.reapply).toHaveBeenCalledTimes(1)
  })

  it('rethrows a failed re-apply and keeps TUN active', async () => {
    const coordinator = new TunCoordinator(adapter(async () => { throw new Error('boom') }), true)
    await coordinator.enable(intent)
    await expect(coordinator.reapplyConfig()).rejects.toThrow('boom')
    expect(coordinator.getStatus().phase).toBe('active')
  })
})

const TARGET = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }

describe('system proxy PAC warning', () => {
  it('warns while enabled when a PAC script is configured', async () => {
    const adapter = new FakeSystemProxyAdapter()
    Object.assign(adapter, { readAutoConfigUrl: async () => 'http://pac.example/proxy.pac' })
    const service = new SystemProxyService({
      adapter,
      probe: new StaticSystemProxyProbe(TARGET),
      backup: new InMemorySystemProxyBackupStore(),
      instanceId: 'test'
    })
    const status = await service.enable()
    expect(status.phase).toBe('enabled')
    expect(status.errorMessage).toContain('PAC')
  })

  it('stays silent without a PAC script or when it cannot be read', async () => {
    for (const read of [async () => null, async () => { throw new Error('no powershell') }]) {
      const adapter = new FakeSystemProxyAdapter()
      Object.assign(adapter, { readAutoConfigUrl: read })
      const service = new SystemProxyService({
        adapter,
        probe: new StaticSystemProxyProbe(TARGET),
        backup: new InMemorySystemProxyBackupStore(),
        instanceId: 'test'
      })
      const status = await service.enable()
      expect(status.phase).toBe('enabled')
      expect(status.errorMessage).toBeNull()
    }
  })
})

describe('system proxy bypass edit when the bundle cannot be saved', () => {
  it('reverts the registry instead of leaving it out of sync with the bundle', async () => {
    const adapter = new FakeSystemProxyAdapter()
    const backup = new InMemorySystemProxyBackupStore()
    const service = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'test' })
    await service.enable()
    const before = (await backup.read()) as SystemProxyBackup
    const write = vi.spyOn(backup, 'write').mockRejectedValueOnce(new Error('disk full'))
    await expect(service.setProxyBypass({ enabled: true, customEntries: ['*.corp.example'] }))
      .rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED })
    write.mockRestore()
    const observed = await adapter.read()
    expect(observed.proxyOverride.value).toBe(before.written.proxyOverride.value)
    expect(service.getStatus().phase).toBe('enabled')
    // The rejected policy is not left behind for a later enable to pick up.
    expect((await service.getProxyBypass()).customEntries).not.toContain('*.corp.example')
  })
})
