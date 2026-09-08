import { describe, expect, it } from 'vitest'
import { inspectActiveProfileConfig } from '../src/main/profiles/profile-config-inspection'

describe('inspectActiveProfileConfig', () => {
  it('compares stored and materialized values, marks ownership and masks the controller secret', () => {
    const result = inspectActiveProfileConfig(
      '机场配置',
      'mixed-port: 7000\nsecret: profile-secret\ntun:\n  enable: false\nglobal-client-fingerprint: chrome\n',
      'mixed-port: 7890\nsecret: runtime-secret\nexternal-controller: 127.0.0.1:9090\ntun:\n  enable: true\n  mtu: 1500\n',
      { coreOverride: true, dnsOverride: false, snifferOverride: false, geodataOverride: false, tunEnabled: true }
    )

    expect(result.profileName).toBe('机场配置')
    expect(result.sections.core.profileYaml).toContain('mixed-port: 7000')
    expect(result.sections.core.effectiveYaml).toContain('mixed-port: 7890')
    expect(result.sections.core.profileYaml).toMatch(/secret: ["']?\*{8}["']?/)
    expect(result.sections.core.effectiveYaml).toMatch(/secret: ["']?\*{8}["']?/)
    expect(JSON.stringify(result.sections)).not.toContain('profile-secret')
    expect(JSON.stringify(result.sections)).not.toContain('runtime-secret')
    expect(result.sections.core.managedKeys).toContain('mixed-port')
    expect(result.sections.tun.effectiveYaml).toContain('mtu: 1500')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', line: 5, message: expect.stringContaining('global-client-fingerprint') })
    ])
  })

  it('returns readable empty excerpts when no profile is active', () => {
    const result = inspectActiveProfileConfig(null, '', '', {
      coreOverride: false, dnsOverride: false, snifferOverride: false, geodataOverride: false, tunEnabled: false
    })
    expect(result.profileName).toBeNull()
    expect(result.sections.dns.profileYaml).toBe('（未配置）')
    expect(result.sections.dns.effectiveYaml).toBe('（未配置）')
  })
})
