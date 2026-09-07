import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { LiveConfigReloader } from '../src/main/kernel/live-config-reloader'
import { EMPTY_CORE_SETTINGS } from '../src/shared/core-settings'
import { EMPTY_GEODATA_SETTINGS } from '../src/shared/geodata'
import { EMPTY_TUN_CONFIG } from '../src/shared/tun-config'

const runtime = {
  mixedPort: 17890,
  controllerPort: 19090,
  secret: 'a'.repeat(64),
  device: 'Example TUN'
}
const document = `
mode: rule
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
dns:
  enable: true
sniffer:
  enable: true
`

function harness(phase: 'stopped' | 'running', tunEnabled = false, mode: 'rule' | 'direct' | 'global' = 'rule') {
  const mihomo = {
    getConfig: vi.fn(async () => ({ mode, tun: { enable: tunEnabled, 'dns-hijack': ['any:53'] } })),
    patchConfig: vi.fn(async (_patch: Record<string, unknown>) => undefined),
    reloadConfig: vi.fn(async (_payload: string) => undefined),
    flushDnsCache: vi.fn(async () => undefined),
    flushFakeIpCache: vi.fn(async () => undefined)
  }
  const reloader = new LiveConfigReloader(
    { getStatus: vi.fn(async () => ({ phase })) },
    mihomo,
    runtime,
    {
      readActiveDocument: vi.fn(async () => document),
      readTunConfig: vi.fn(async () => ({ ...EMPTY_TUN_CONFIG })),
      readCore: vi.fn(async () => ({ ...EMPTY_CORE_SETTINGS })),
      readGeodata: vi.fn(async () => ({ ...EMPTY_GEODATA_SETTINGS }))
    }
  )
  return { reloader, mihomo }
}

describe('LiveConfigReloader', () => {
  it('defers cleanly while the kernel is stopped', async () => {
    const { reloader, mihomo } = harness('stopped')
    await expect(reloader.reloadIfRunning()).resolves.toBe(false)
    expect(mihomo.getConfig).not.toHaveBeenCalled()
    expect(mihomo.reloadConfig).not.toHaveBeenCalled()
  })

  it('full reload preserves DNS and sniffer without enabling TUN', async () => {
    const { reloader, mihomo } = harness('running')
    await expect(reloader.reloadIfRunning()).resolves.toBe(true)
    const config = parse(mihomo.reloadConfig.mock.calls[0][0]) as Record<string, unknown>
    expect(config.dns).toMatchObject({ enable: true })
    expect(config.sniffer).toMatchObject({ enable: true })
    expect(config.tun).toBeUndefined()
  })

  it('hot patches only DNS without reloading providers or the TUN adapter', async () => {
    const { reloader, mihomo } = harness('running', true)

    await expect(reloader.patchSectionsIfRunning(['dns'])).resolves.toBe(true)

    expect(mihomo.patchConfig).toHaveBeenCalledOnce()
    expect(mihomo.patchConfig).toHaveBeenCalledWith({ dns: expect.objectContaining({ enable: true }) })
    expect(mihomo.reloadConfig).not.toHaveBeenCalled()
    expect(mihomo.flushDnsCache).toHaveBeenCalledOnce()
    expect(mihomo.flushFakeIpCache).toHaveBeenCalledOnce()
  })

  it('hot patches only sniffer without reloading providers', async () => {
    const { reloader, mihomo } = harness('running')

    await expect(reloader.patchSectionsIfRunning(['sniffer'])).resolves.toBe(true)

    expect(mihomo.patchConfig).toHaveBeenCalledWith({ sniffer: expect.objectContaining({ enable: true }) })
    expect(mihomo.reloadConfig).not.toHaveBeenCalled()
    expect(mihomo.flushDnsCache).not.toHaveBeenCalled()
  })

  it('hot patches geodata controls without reloading providers', async () => {
    const { reloader, mihomo } = harness('running')

    await expect(reloader.patchSectionsIfRunning(['geodata'])).resolves.toBe(true)

    expect(mihomo.patchConfig).toHaveBeenCalledWith(expect.objectContaining({
      'geodata-mode': false,
      'geodata-loader': 'standard',
      'geo-auto-update': false,
      'geo-update-interval': 24,
      'geox-url': expect.any(Object)
    }))
    expect(mihomo.reloadConfig).not.toHaveBeenCalled()
  })

  it('preserves active TUN and a temporary global outbound mode atomically', async () => {
    const { reloader, mihomo } = harness('running', true, 'global')
    await reloader.reloadIfRunning()
    const config = parse(mihomo.reloadConfig.mock.calls[0][0]) as { mode: string; tun: { enable: boolean } }
    expect(config.tun.enable).toBe(true)
    expect(config.mode).toBe('global')
    expect(mihomo.reloadConfig).toHaveBeenCalledOnce()
  })
})
