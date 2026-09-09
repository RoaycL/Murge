import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { LiveConfigReloader } from '../src/main/kernel/live-config-reloader'
import { EMPTY_CORE_SETTINGS } from '../src/shared/core-settings'
import { EMPTY_GEODATA_SETTINGS } from '../src/shared/geodata'
import { EMPTY_SNIFFER_ENHANCEMENT } from '../src/shared/sniffer'
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
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
sniffer:
  enable: true
  override-destination: false
  force-dns-mapping: true
  parse-pure-ip: true
`

function harness(
  phase: 'stopped' | 'running',
  tunEnabled = false,
  mode: 'rule' | 'direct' | 'global' = 'rule',
  baseDocument = 'mode: rule\nproxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]\n'
) {
  const snapshot: Record<string, unknown> = {
    mode,
    sniffing: true,
    tun: { enable: tunEnabled, 'dns-hijack': ['any:53'] }
  }
  const mihomo = {
    getConfig: vi.fn(async () => ({ ...snapshot })),
    patchConfig: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(snapshot, patch) }),
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
      readBaseDocument: vi.fn(async () => baseDocument),
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

  it('reloads the full payload for DNS because mihomo ignores DNS in PATCH /configs', async () => {
    const { reloader, mihomo } = harness('running', true)

    await expect(reloader.applySectionsIfRunning(['dns'])).resolves.toBe(true)

    expect(mihomo.patchConfig).not.toHaveBeenCalled()
    expect(mihomo.reloadConfig).toHaveBeenCalledOnce()
    const config = parse(mihomo.reloadConfig.mock.calls[0][0]) as Record<string, unknown>
    expect(config.dns).toMatchObject({
      enable: true,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16'
    })
    expect(config.tun).toMatchObject({ enable: true })
    expect(mihomo.flushDnsCache).toHaveBeenCalledOnce()
    expect(mihomo.flushFakeIpCache).toHaveBeenCalledOnce()
  })

  it('reloads the full payload for sniffer because mihomo ignores sniffer in PATCH /configs', async () => {
    const { reloader, mihomo } = harness('running')

    await expect(reloader.applySectionsIfRunning(['sniffer'])).resolves.toBe(true)

    expect(mihomo.patchConfig).not.toHaveBeenCalled()
    expect(mihomo.reloadConfig).toHaveBeenCalledOnce()
    const config = parse(mihomo.reloadConfig.mock.calls[0][0]) as Record<string, unknown>
    expect(config.sniffer).toMatchObject({
      enable: true,
      'override-destination': false,
      'force-dns-mapping': true,
      'parse-pure-ip': true
    })
    expect(mihomo.flushDnsCache).not.toHaveBeenCalled()
  })

  it('uses one payload reload when DNS and sniffer are applied together', async () => {
    const { reloader, mihomo } = harness('running', true)

    await expect(reloader.applySectionsIfRunning(['dns', 'sniffer'])).resolves.toBe(true)

    expect(mihomo.reloadConfig).toHaveBeenCalledOnce()
    expect(mihomo.patchConfig).not.toHaveBeenCalled()
    const config = parse(mihomo.reloadConfig.mock.calls[0][0]) as Record<string, unknown>
    expect(config.dns).toMatchObject({ enable: true })
    expect(config.sniffer).toMatchObject({ enable: true })
  })

  it('mutes and restores an already-loaded sniffer without reloading TUN or providers', async () => {
    const { reloader, mihomo } = harness('running', true)
    const enabled = { ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true }
    const disabled = { ...enabled, enabled: false }

    await expect(reloader.applySnifferTransitionIfRunning(enabled, disabled)).resolves.toBe(true)
    await expect(reloader.applySnifferTransitionIfRunning(disabled, enabled)).resolves.toBe(true)

    expect(mihomo.patchConfig.mock.calls).toEqual([
      [{ sniffing: false }],
      [{ sniffing: true }]
    ])
    expect(mihomo.reloadConfig).not.toHaveBeenCalled()
  })

  it('falls back to a full reload when the base profile owns an enabled sniffer', async () => {
    const { reloader, mihomo } = harness('running', true, 'rule', document)
    const enabled = { ...EMPTY_SNIFFER_ENHANCEMENT, enabled: true }

    await expect(reloader.applySnifferTransitionIfRunning(
      enabled,
      { ...enabled, enabled: false }
    )).resolves.toBe(true)

    expect(mihomo.patchConfig).not.toHaveBeenCalled()
    expect(mihomo.reloadConfig).toHaveBeenCalledOnce()
  })

  it('uses a full reload for the first enable after startup because no dispatcher is cached', async () => {
    const { reloader, mihomo } = harness('running', true)
    const disabled = { ...EMPTY_SNIFFER_ENHANCEMENT, enabled: false }

    await expect(reloader.applySnifferTransitionIfRunning(
      disabled,
      { ...disabled, enabled: true }
    )).resolves.toBe(true)

    expect(mihomo.patchConfig).not.toHaveBeenCalled()
    expect(mihomo.reloadConfig).toHaveBeenCalledOnce()
  })

  it('hot patches geodata controls without reloading providers', async () => {
    const { reloader, mihomo } = harness('running')

    await expect(reloader.applySectionsIfRunning(['geodata'])).resolves.toBe(true)

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
