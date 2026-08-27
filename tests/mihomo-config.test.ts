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

const SECRET = 'a'.repeat(64)
const base = {
  mixedPort: 20000,
  controllerPort: 20001,
  secret: SECRET
}
const SECRET_2 = 'b'.repeat(64)

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

  it('rejects privileged and out-of-range ports', () => {
    expect(() => generateMihomoConfig({ ...base, mixedPort: 80 })).toThrowError(ProtocolError)
    expect(() => generateMihomoConfig({ ...base, mixedPort: 65536 })).toThrowError(ProtocolError)
    expect(() => generateMihomoConfig({ ...base, controllerPort: 80 })).toThrowError(ProtocolError)
  })

  it('rejects a secret that is not 64-hex', () => {
    expect(() => generateMihomoConfig({ ...base, secret: 'short' })).toThrowError(ProtocolError)
    expect(() => generateMihomoConfig({ ...base, secret: 'g'.repeat(64) })).toThrowError(
      ProtocolError
    )
    // Multi-line / comment / colon / quote injection must all be refused.
    expect(() => generateMihomoConfig({ ...base, secret: `${'a'.repeat(64)}\n# pwn` })).toThrowError(
      ProtocolError
    )
    expect(() =>
      generateMihomoConfig({ ...base, secret: `${'a'.repeat(64)}:${'b'.repeat(2)}` })
    ).toThrowError(ProtocolError)
  })

  it('rejects a non-direct mode', () => {
    expect(() =>
      generateMihomoConfig({ ...base, mode: 'rule' as never })
    ).toThrowError(ProtocolError)
  })
})

describe('mihomoConfigErrors / validateMihomoConfigYaml', () => {
  const validText = () => generateMihomoConfig(base)

  it('reports a forbidden key that would mutate the network stack', () => {
    const text = validText() + 'redir-port: 12345\n'
    expect(mihomoConfigErrors(text)).toEqual(
      expect.arrayContaining(['unknown top-level key: redir-port'])
    )
    expect(() => validateMihomoConfigYaml(text)).toThrowError(/redir-port/)
  })

  it('reports any unknown listener/stack key', () => {
    for (const key of ['socks-port', 'listeners', 'hosts', 'profile', 'sniffer', 'proxy-providers']) {
      const text = validText() + `${key}: {}\n`
      expect(mihomoConfigErrors(text)).toContain(`unknown top-level key: ${key}`)
    }
  })

  it('reports a controller that is not loopback-bound', () => {
    const text = validText().replace('127.0.0.1:20001', '0.0.0.0:20001')
    expect(mihomoConfigErrors(text)).toEqual(
      expect.arrayContaining(['external-controller must be bound to 127.0.0.1'])
    )
  })

  it('reports a privileged external-controller port', () => {
    const text = validText().replace('127.0.0.1:20001', '127.0.0.1:80')
    expect(mihomoConfigErrors(text)).toEqual(
      expect.arrayContaining([
        'external-controller port must be unprivileged (1024-65535)'
      ])
    )
  })

  it('reports allow-lan and mode violations', () => {
    const text = validText()
      .replace('allow-lan: false', 'allow-lan: true')
      .replace('mode: direct', 'mode: global')
    const errors = mihomoConfigErrors(text)
    expect(errors).toContain('allow-lan must be false')
    expect(errors).toContain('mode must be direct')
  })

  it('reports tun/dns enable and rules violations', () => {
    const text = validText()
      .replace('tun:\n  enable: false', 'tun:\n  enable: true')
      .replace('dns:\n  enable: false', 'dns:\n  enable: true')
      .replace('  - MATCH,DIRECT\n', '  - MATCH,REJECT\n')
    const errors = mihomoConfigErrors(text)
    expect(errors).toContain('tun.enable must be false')
    expect(errors).toContain('dns.enable must be false')
    expect(errors).toContain('rules must contain only MATCH,DIRECT')
  })

  it('rejects a non-loopback tun mode and an extra rule', () => {
    const text = validText().replace(
      'rules:\n  - MATCH,DIRECT\n',
      'rules:\n  - MATCH,DIRECT\n  - MATCH,REJECT\n'
    )
    expect(mihomoConfigErrors(text)).toContain('rules must contain exactly [MATCH,DIRECT]')
  })

  it('rejects a duplicate top-level key', () => {
    const text = validText() + 'dns:\n  enable: true\n'
    expect(mihomoConfigErrors(text)).toContain('duplicate key: dns')
  })

  it('rejects a duplicate secret key', () => {
    const text = validText() + `secret: ${SECRET_2}\n`
    expect(mihomoConfigErrors(text)).toContain('duplicate key: secret')
  })

  it('rejects YAML aliases and tags', () => {
    const aliased = validText() + 'derived: *anchor\nshared: &anchor 1\n'
    expect(mihomoConfigErrors(aliased)).toContain('config must not use YAML aliases')

    const tagged = validText().replace('mode: direct', 'mode: !!str direct')
    expect(mihomoConfigErrors(tagged)).toEqual(
      expect.arrayContaining([expect.stringContaining('uses a YAML tag, which is not allowed')])
    )
  })

  it('rejects a composite (non-scalar) top-level key', () => {
    const text = validText() + '? [a, b]\n: value\n'
    expect(mihomoConfigErrors(text)).toContain('top-level keys must be plain scalar strings')
  })

  it('rejects a complex object as a scalar-key value', () => {
    const text = validText().replace('mode: direct', 'mode:\n  nested: true')
    expect(mihomoConfigErrors(text)).toContain('mode must be a scalar value')
  })

  it('rejects tun/dns members other than enable', () => {
    const text = validText()
      .replace('tun:\n  enable: false', 'tun:\n  enable: false\n  auto-route: true')
      .replace('dns:\n  enable: false', 'dns:\n  enable: false\n  listen: 0.0.0.0:53')
    const errors = mihomoConfigErrors(text)
    expect(errors).toContain("tun may only contain 'enable'")
    expect(errors).toContain("dns may only contain 'enable'")
  })

  it('reports missing required keys', () => {
    const text = validText().replace('rules:\n  - MATCH,DIRECT\n', '')
    expect(mihomoConfigErrors(text)).toContain('missing required key: rules')
  })

  it('rejects secret injection attempts (newline/colon/comment/quote/unicode)', () => {
    const payloads: Array<{ name: string; value: string }> = [
      { name: 'newline', value: `${'a'.repeat(64)}\n  enable: true` },
      { name: 'colon', value: `${'a'.repeat(64)}:${'b'.repeat(2)}` },
      { name: 'comment', value: `${'a'.repeat(64)}#evil` },
      { name: 'quote', value: `"1234567890abcdef"` },
      { name: 'unicode control', value: `${'a'.repeat(63)}\u0000b` }
    ]
    for (const { name, value } of payloads) {
      const text = validText().replace(`secret: ${SECRET}`, `secret: ${value}`)
      const errors = mihomoConfigErrors(text)
      expect(errors.length, `secret injection via ${name} must be rejected`).toBeGreaterThan(0)
      expect(() => validateMihomoConfigYaml(text)).toThrowError(ProtocolError)
    }

    // A well-formed but non-hex scalar produces the specific coverage error.
    const colon = validText().replace(`secret: ${SECRET}`, `secret: ${'a'.repeat(64)}:${'b'.repeat(2)}`)
    expect(mihomoConfigErrors(colon)).toContain('secret must be a 64-character lowercase hex string')
  })

  it('throws INVALID_ARGUMENT for any violation', () => {
    const text = validText() + 'tproxy-port: 7890\n'
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
    expect(sanitized).not.toContain(SECRET)
    expect(sanitized).toContain('secret: <redacted>')
    expect(sanitized).toContain(`mixed-port: ${base.mixedPort}`)
  })

  it('masks a secret on multi-line or abnormal content without leaking the token', () => {
    // A malicious document that slipped a secret into an object block must not
    // leak the 64-hex token into a sanitized evidence blob.
    const text = `garbage:\n  secret: ${SECRET}\n`
    const sanitized = sanitizeMihomoConfig(text)
    expect(sanitized).not.toContain(SECRET)
    expect(sanitized).toContain('<redacted>')
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
  it('reserves a usable loopback port in the unprivileged range', async () => {
    const port = await findFreePort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
  })
})
