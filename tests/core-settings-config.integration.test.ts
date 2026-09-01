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
  findProcessMode: 'off'
}

function build(core?: CoreSettings): Record<string, unknown> {
  return parse(buildProfileKernelConfig(PROFILE, { mixedPort: 2080, controllerPort: 2090, secret: SECRET, core }))
}

describe('controlled core settings config integration', () => {
  it('read-back: an enabled model is authoritative in the runtime config', () => {
    const out = build(ENABLED)
    // Read-back: the runtime config reflects exactly the controlled model.
    expect(out['log-level']).toBe('error')
    expect(out.ipv6).toBe(false)
    expect(out['tcp-concurrent']).toBe(false)
    expect(out['unified-delay']).toBe(true)
    expect(out['find-process-mode']).toBe('off')
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
