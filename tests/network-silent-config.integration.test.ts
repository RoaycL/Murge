import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { applyDnsEnhancementToDocument } from '../src/main/kernel/dns/apply-dns'
import { applySnifferEnhancementToDocument } from '../src/main/kernel/sniffer/apply-sniffer'
import { buildProfileKernelConfig, profileKernelConfigErrors } from '../src/main/kernel/profile-kernel-config'
import { EMPTY_DNS_ENHANCEMENT, type DnsEnhancement } from '@shared/dns'
import { EMPTY_SNIFFER_ENHANCEMENT, type SnifferEnhancement } from '@shared/sniffer'

/**
 * Network-silent integration test for the composed main-kernel config pipeline:
 * active profile + typed DNS enhancement + typed Sniffer enhancement, then the
 * `buildProfileKernelConfig` safety boundary. This is network-silent by
 * construction — it only runs pure YAML transforms and never spawns mihomo,
 * binds a port, touches routes/DNS/system-proxy, or writes any file. It proves
 * the pipeline cannot leak a host-network mutation into the runtime config and
 * that the result round-trips (parse-back) through the profile validator.
 */
const MIXED_PORT = 2080
const CONTROLLER_PORT = 9090
const SECRET = 'a'.repeat(64)

const BASE = `
port: 7890
socks-port: 7891
redir-port: 7892
tproxy-port: 7893
allow-lan: true
bind-address: 0.0.0.0
listeners:
  - name: public
    listen: 0.0.0.0:10086
tun:
  enable: true
  device: Wintun
  dns-hijack:
    - any:53
dns:
  enable: true
  listen: 0.0.0.0:53
  fallback-filter:
    geoip: true
sniffer:
  enable: true
  port-black-list:
    - 8080
proxies:
  - name: DIRECT
    type: direct
rules:
  - MATCH,DIRECT
`

const DNS_ENABLED: DnsEnhancement = {
  ...EMPTY_DNS_ENHANCEMENT,
  enabled: true,
  nameserver: ['https://1.1.1.1/dns-query'],
  defaultNameserver: ['1.1.1.1', '8.8.8.8']
}

const SNIFFER_ENABLED: SnifferEnhancement = {
  ...EMPTY_SNIFFER_ENHANCEMENT,
  enabled: true
}

function compose(base: string, dns: DnsEnhancement, sniffer: SnifferEnhancement): string {
  const withDns = applyDnsEnhancementToDocument(base, dns)
  if (withDns.warnings.length > 0) throw new Error(withDns.warnings.join('；'))
  const withSniffer = applySnifferEnhancementToDocument(withDns.text, sniffer)
  if (withSniffer.warnings.length > 0) throw new Error(withSniffer.warnings.join('；'))
  return buildProfileKernelConfig(withSniffer.text, {
    mixedPort: MIXED_PORT,
    controllerPort: CONTROLLER_PORT,
    secret: SECRET
  })
}

describe('composed DNS+Sniffer main-kernel config', () => {
  it('is network-silent and parse-back valid with both enhancements enabled', () => {
    const built = compose(BASE, DNS_ENABLED, SNIFFER_ENABLED)

    // Parse-back: the runtime artifact must be structurally valid mihomo YAML.
    expect(profileKernelConfigErrors(built)).toEqual([])

    const cfg = parse(built) as Record<string, unknown>

    // Host-network mutation is neutralized.
    expect(cfg.tun).toBeUndefined()
    expect(cfg.listeners).toBeUndefined()
    expect(cfg['redir-port']).toBeUndefined()
    expect(cfg['tproxy-port']).toBeUndefined()
    expect(cfg.port).toBeUndefined()
    expect(cfg['socks-port']).toBeUndefined()
    expect(cfg['external-controller-unix']).toBeUndefined()
    expect(cfg['external-controller-pipe']).toBeUndefined()

    // Loopback-only proxy + controller and no public bind anywhere.
    expect(cfg['allow-lan']).toBe(false)
    expect(cfg['bind-address']).toBe('127.0.0.1')
    expect(cfg['external-controller']).toBe(`127.0.0.1:${CONTROLLER_PORT}`)
    expect(cfg['mixed-port']).toBe(MIXED_PORT)
    expect(cfg.secret).toBe(SECRET)
    expect(built).not.toMatch(/0\.0\.0\.0/)

    // The model's DNS values survive the safety pass without leaking `listen`.
    const dns = cfg.dns as Record<string, unknown>
    expect(dns.listen).toBeUndefined()
    expect(dns.enable).toBe(true)
    expect(dns['enhanced-mode']).toBe('fake-ip')
    expect(dns['fake-ip-range']).toBe('198.18.0.1/16')
    expect(dns.nameserver).toEqual(['https://1.1.1.1/dns-query'])
    expect(dns['default-nameserver']).toEqual(['1.1.1.1', '8.8.8.8'])
    // Profile-only DNS keys the model does not own are preserved.
    expect(dns['fallback-filter']).toEqual({ geoip: true })
    expect(dns['respect-rules']).toBe(false)

    // The model's Sniffer values are carried (sniffing does not mutate the host
    // network) while profile-only keys are preserved.
    const sniffer = cfg.sniffer as Record<string, unknown>
    expect(sniffer.enable).toBe(true)
    expect(sniffer['override-destination']).toBe(true)
    expect(sniffer['force-dns-mapping']).toBe(true)
    expect(sniffer['parse-pure-ip']).toBe(true)
    expect((sniffer.sniff as Record<string, unknown>).HTTP).toEqual({ ports: ['80', '8080-8880'] })
    expect(sniffer['port-black-list']).toEqual([8080])
  })

  it('stays loopback-only even when the enhancement inputs carry a public bind', () => {
    const hostileDns: DnsEnhancement = { ...DNS_ENABLED, nameserver: ['dhcp://192.168.31.1'] }
    const hostile = BASE.replace('dns:\n  enable: true\n  listen: 0.0.0.0:53', 'dns:\n  enable: true\n  listen: 0.0.0.0:5353')
    const built = compose(hostile, hostileDns, SNIFFER_ENABLED)

    expect(profileKernelConfigErrors(built)).toEqual([])
    const cfg = parse(built) as Record<string, unknown>
    expect(cfg['allow-lan']).toBe(false)
    expect(cfg['bind-address']).toBe('127.0.0.1')
    expect((cfg.dns as Record<string, unknown>).listen).toBeUndefined()
    expect(built).not.toMatch(/0\.0\.0\.0/)
  })

  it('keeps the base content and stays network-silent when enhancements are disabled', () => {
    const built = compose(BASE, { ...EMPTY_DNS_ENHANCEMENT, enabled: false }, { ...EMPTY_SNIFFER_ENHANCEMENT, enabled: false })

    expect(profileKernelConfigErrors(built)).toEqual([])
    const cfg = parse(built) as Record<string, unknown>
    expect(cfg['allow-lan']).toBe(false)
    expect(cfg['bind-address']).toBe('127.0.0.1')
    expect(cfg['mixed-port']).toBe(MIXED_PORT)
    expect(cfg.proxies).toEqual([{ name: 'DIRECT', type: 'direct' }])
    expect(cfg.rules).toEqual(['MATCH,DIRECT'])
    expect(built).not.toMatch(/0\.0\.0\.0/)
  })
})
