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
    // Phase 1: startup orchestration lives in the electron shell modules.
    const startup = [
      'src/main/index.ts',
      'src/main/electron/bootstrap.ts',
      'src/main/electron/when-ready.ts'
    ].map((path) => read(path)).join('\n')
    expect(startup).not.toMatch(/g1-(?:driver|probe|probe-runner)/)
    expect(startup).not.toContain('wintun-abi')
  })
})
