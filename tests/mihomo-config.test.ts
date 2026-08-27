import { describe, it, expect } from 'vitest'
import {
  generateMihomoConfig,
  validateMihomoConfigYaml,
  mihomoConfigErrors,
  sanitizeMihomoConfig,
  randomSecret
} from '../src/main/kernel/mihomo-config'
import { findFreePort } from '../src/main/kernel/mihomo-config-store'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

const base = {
  mixedPort: 20000,
  controllerPort: 20001,
  secret: 'a'.repeat(32)
}

describe('generateMihomoConfig', () => {
  it('renders a strict loopback-only direct config that validates clean', () => {
    const text = generateMihomoConfig(base)
    expect(() => validateMihomoConfigYaml(text)).not.toThrow()
    expect(mihomoConfigErrors(text)).toEqual([])
  })

  it('pins the security-relevant fields', () => {
    const text = generateMihomoConfig(base)
    expect(text).toContain(`mixed-port: ${base.mixedPort}`)
    expect(text).toContain('allow-lan: false')
    expect(text).toContain('mode: direct')
    expect(text).toContain('log-level: info')
    expect(text).toContain('ipv6: false')
    expect(text).toContain(`external-controller: 127.0.0.1:${base.controllerPort}`)
    expect(text).toContain(`secret: ${base.secret}`)
    expect(text).toContain('tun:')
    expect(text).toContain('  enable: false')
    expect(text).toContain('dns:')
    expect(text).toContain('  enable: false')
    expect(text).toContain('  - MATCH,DIRECT')
  })

  it('rejects a controller port that collides with the mixed port', () => {
    expect(() =>
      generateMihomoConfig({ ...base, controllerPort: base.mixedPort })
    ).toThrowError(ProtocolError)
  })

  it('rejects a short secret', () => {
    expect(() => generateMihomoConfig({ ...base, secret: 'short' })).toThrowError(ProtocolError)
  })

  it('rejects a non-direct mode', () => {
    expect(() =>
      generateMihomoConfig({ ...base, mode: 'rule' as never })
    ).toThrowError(ProtocolError)
  })
})

describe('mihomoConfigErrors / validateMihomoConfigYaml', () => {
  it('reports a forbidden key that would mutate the network stack', () => {
    const text = generateMihomoConfig(base) + 'redir-port: 12345\n'
    expect(mihomoConfigErrors(text)).toEqual(
      expect.arrayContaining([expect.stringContaining('redir-port')])
    )
    expect(() => validateMihomoConfigYaml(text)).toThrowError(/redir-port/)
  })

  it('reports a controller that is not loopback-bound', () => {
    const text = generateMihomoConfig(base).replace('127.0.0.1:20001', '0.0.0.0:20001')
    expect(mihomoConfigErrors(text)).toEqual(
      expect.arrayContaining(['external-controller must be bound to 127.0.0.1'])
    )
  })

  it('reports allow-lan and mode violations', () => {
    const text = generateMihomoConfig(base)
      .replace('allow-lan: false', 'allow-lan: true')
      .replace('mode: direct', 'mode: global')
    const errors = mihomoConfigErrors(text)
    expect(errors).toContain('allow-lan must be false')
    expect(errors).toContain('mode must be direct')
  })

  it('reports missing tun/dns enable and missing rules MATCH,DIRECT', () => {
    const text = generateMihomoConfig(base)
      .replace('tun:\n  enable: false', 'tun:\n  enable: true')
      .replace('dns:\n  enable: false', 'dns:\n  enable: true')
      .replace('  - MATCH,DIRECT\n', '  - MATCH,REJECT\n')
    const errors = mihomoConfigErrors(text)
    expect(errors).toContain('tun.enable must be false')
    expect(errors).toContain('dns.enable must be false')
    expect(errors).toContain('rules must contain MATCH,DIRECT')
  })

  it('throws INVALID_ARGUMENT for any violation', () => {
    const text = generateMihomoConfig(base) + 'tproxy-port: 7890\n'
    try {
      validateMihomoConfigYaml(text)
      expect.unreachable()
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.INVALID_ARGUMENT)
    }
  })
})

describe('sanitizeMihomoConfig', () => {
  it('masks the secret and leaves the rest intact', () => {
    const text = generateMihomoConfig(base)
    const sanitized = sanitizeMihomoConfig(text)
    expect(sanitized).not.toContain(base.secret)
    expect(sanitized).toContain('secret: <redacted>')
    expect(sanitized).toContain(`mixed-port: ${base.mixedPort}`)
  })
})

describe('randomSecret', () => {
  it('generates high-entropy hex of the requested byte length', () => {
    const secret = randomSecret(32)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is unique across calls', () => {
    const a = randomSecret(24)
    const b = randomSecret(24)
    expect(a).not.toBe(b)
  })

  it('rejects an invalid byte length', () => {
    expect(() => randomSecret(0)).toThrowError(ProtocolError)
    expect(() => randomSecret(2048)).toThrowError(ProtocolError)
  })
})

describe('findFreePort', () => {
  it('reserves a usable loopback port', async () => {
    const port = await findFreePort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })
})
