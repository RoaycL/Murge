import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { buildProfileKernelConfig } from '../src/main/kernel/profile-kernel-config'
import type { CoreSettings } from '../src/shared/core-settings'
import { EMPTY_CORE_SETTINGS } from '../src/shared/core-settings'

const SECRET = 'a'.repeat(64)

/** A profile that deliberately sets its own core keys, to prove conflict handling. */
const PROFILE = [
  'mixed-port: 7890',
  'log-level: debug',
  'ipv6: true',
  'tcp-concurrent: true',
  'allow-lan: true',
  'external-controller: 0.0.0.0:9090',
  'dns:',
  '  enable: true',
  '  ipv6: true',
  'proxies:',
  '  - name: P1',
  '    type: ss',
  '    server: 1.2.3.4',
  '    port: 443',
  '    cipher: aes-256-gcm',
  '    password: secret',
  'rules:',
  '  - MATCH,DIRECT',
  ''
].join('\n')

const ENABLED: CoreSettings = {
  ...EMPTY_CORE_SETTINGS,
  enabled: true,
  logLevel: 'error',
  ipv6: false,
  tcpConcurrent: false,
  unifiedDelay: true,
  findProcessMode: 'off',
  interfaceName: 'Ethernet'
}

function build(core?: CoreSettings): Record<string, unknown> {
  return parse(buildProfileKernelConfig(PROFILE, { mixedPort: 2080, controllerPort: 2090, secret: SECRET, core }))
}

describe('controlled core settings config integration', () => {
  it('applies the user-owned listener, LAN and managed panel settings', () => {
    const out = parse(buildProfileKernelConfig(PROFILE, {
      mixedPort: 7890,
      httpPort: 7892,
      socksPort: 7891,
      controllerHost: '0.0.0.0',
      controllerPort: 9090,
      secret: SECRET,
      allowLan: true,
      controllerPanel: true,
      core: ENABLED
    })) as Record<string, unknown>
    expect(out).toMatchObject({
      port: 7892,
      'socks-port': 7891,
      'mixed-port': 7890,
      'external-controller': '0.0.0.0:9090',
      'allow-lan': true,
      'bind-address': '*',
      'external-ui': 'ui',
      'external-ui-name': 'metacubexd'
    })
  })
  it('read-back: an enabled model is authoritative in the runtime config', () => {
    const out = build(ENABLED)
    // Read-back: the runtime config reflects exactly the controlled model.
    expect(out['log-level']).toBe('error')
    expect(out.ipv6).toBe(false)
    expect((out.dns as Record<string, unknown>).ipv6).toBe(false)
    expect(out['tcp-concurrent']).toBe(false)
    expect(out['unified-delay']).toBe(true)
    expect(out.profile).toEqual({ 'store-selected': true, 'store-fake-ip': true })
    expect(out['find-process-mode']).toBe('off')
    expect(out['interface-name']).toBe('Ethernet')
  })

  it('merges controlled persistence flags without deleting other profile keys', () => {
    const document = `${PROFILE}\nprofile:\n  tracing: true\n  store-selected: false\n`
    const out = parse(buildProfileKernelConfig(document, {
      mixedPort: 2080, controllerPort: 2090, secret: SECRET, core: ENABLED
    })) as Record<string, unknown>
    expect(out.profile).toEqual({ tracing: true, 'store-selected': true, 'store-fake-ip': true })
  })

  it('conflict handling: an enabled model overrides the profile own keys', () => {
    const out = build(ENABLED)
    // The profile set log-level: debug / ipv6: true / tcp-concurrent: true; the
    // controlled model wins on every allowlisted key.
    expect(out['log-level']).not.toBe('debug')
    expect(out.ipv6).not.toBe(true)
    expect(out['tcp-concurrent']).not.toBe(true)
  })

  it('disabled / absent model preserves the profile own core keys', () => {
    // disabled => no injection
    const disabled = build({ ...EMPTY_CORE_SETTINGS, enabled: false, logLevel: 'error', tcpConcurrent: true })
    expect(disabled['log-level']).toBe('debug')
    expect(disabled.ipv6).toBe(true)
    expect((disabled.dns as Record<string, unknown>).ipv6).toBe(true)
    expect(disabled['tcp-concurrent']).toBe(true)
    expect(disabled['unified-delay']).toBeUndefined()
    expect(disabled['find-process-mode']).toBeUndefined()

    // absent (undefined) => same preservation
    const absent = build()
    expect(absent['log-level']).toBe('debug')
    expect(absent['tcp-concurrent']).toBe(true)
  })

  it('still enforces the main-kernel safety boundary alongside core settings', () => {
    const out = build(ENABLED)
    expect(out['allow-lan']).toBe(false)
    expect(out['bind-address']).toBe('127.0.0.1')
    expect(out['external-controller']).toBe('127.0.0.1:2090')
    expect(out['mixed-port']).toBe(2080)
    expect(out.tun).toBeUndefined()
  })
})
