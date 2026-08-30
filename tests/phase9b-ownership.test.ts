import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('Phase 9B single network-state owner', () => {
  it('keeps the production Phase 9B modules free of direct Wintun and OS network mutation APIs', () => {
    const files = [
      'src/main/tun/mihomo-tun-config.ts',
      'src/main/tun/service-protocol.ts',
      'src/main/tun/service-client.ts',
      'src/main/tun/mihomo-owned-adapter.ts',
      'src/main/tun/coordinator.ts'
    ]
    const forbidden = [
      'WintunCreateAdapter', 'WintunOpenAdapter', 'WintunCloseAdapter',
      'CreateIpForwardEntry', 'SetInterfaceDnsSettings', 'netsh ',
      'Set-DnsClientServerAddress', 'New-NetRoute', 'Remove-NetRoute'
    ]
    for (const file of files) {
      const source = read(file)
      for (const marker of forbidden) expect(source, `${file} contains ${marker}`).not.toContain(marker)
    }
  })

  it('does not wire the superseded G1 driver into application startup', () => {
    const startup = read('src/main/index.ts')
    expect(startup).not.toMatch(/g1-(?:driver|probe|probe-runner)/)
    expect(startup).not.toContain('wintun-abi')
  })

  it('documents that runtime evidence remains Windows-only', () => {
    const decision = read('docs/phase9b-mihomo-owned-tun.md')
    expect(decision).toContain('Windows runtime evidence pending')
    expect(decision.toLowerCase()).toContain('mihomo is the **only owner**')
    expect(decision).toMatch(/must never claim runtime TUN\s+success/)
  })
})
