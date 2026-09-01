import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { redactOverrideContent, diffLines } from '../src/shared/overrides'
import {
  validateJsOverride,
  validateOverrideContent,
  applyOverridesToDocument
} from '../src/main/kernel/overrides/apply-overrides'
import { OverrideService } from '../src/main/kernel/overrides/override-service'
import { buildProfileKernelConfig } from '../src/main/kernel/profile-kernel-config'

let dir: string | null = null
async function makeDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'murge-ovrp-'))
  return dir
}
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = null
  }
})

const BASE = 'mode: rule\nrules:\n  - MATCH,DIRECT\n'

describe('redactOverrideContent', () => {
  it('masks URL user-info', () => {
    expect(redactOverrideContent('url: http://user:secret@example.com/x')).toBe('url: http://***@example.com/x')
  })

  it('masks credential key values', () => {
    expect(redactOverrideContent('secret: abcd1234')).toBe('secret: ***')
    expect(redactOverrideContent('  authorization: Bearer eyJhbGci')).toBe('  authorization: ***')
  })

  it('masks 64-hex secrets', () => {
    const hex = 'a'.repeat(64)
    expect(redactOverrideContent(`secret: ${hex}`)).toBe('secret: ***')
  })

  it('returns empty text unchanged', () => {
    expect(redactOverrideContent('')).toBe('')
  })
})

describe('diffLines', () => {
  it('detects a line addition', () => {
    const segments = diffLines('a\nb\n', 'a\nb\nc\n')
    const added = segments.filter((s) => s.type === 'added').map((s) => s.text)
    expect(added).toEqual(['c'])
  })

  it('detects a line removal', () => {
    const segments = diffLines('a\nb\nc\n', 'a\nc\n')
    const removed = segments.filter((s) => s.type === 'removed').map((s) => s.text)
    expect(removed).toEqual(['b'])
  })

  it('returns all context for identical inputs', () => {
    const segments = diffLines('a\nb\n', 'a\nb\n')
    expect(segments.every((s) => s.type === 'context')).toBe(true)
    expect(segments.map((s) => s.text)).toEqual(['a', 'b', ''])
  })
})

describe('validateJsOverride / validateOverrideContent', () => {
  it('accepts a JS body that defines main', () => {
    expect(validateJsOverride('function main(config){ return config }')).toBeNull()
  })

  it('rejects a JS body with no main', () => {
    const issue = validateJsOverride('const x = 1')
    expect(issue).toMatch(/main/)
  })

  it('rejects a throwing JS body', () => {
    const issue = validateJsOverride('throw new Error("boom")')
    expect(issue).toMatch(/boom/)
  })

  it('accepts a YAML map and rejects a scalar', () => {
    expect(validateOverrideContent({ kind: 'yaml', content: 'mode: rule' })).toBeNull()
    expect(validateOverrideContent({ kind: 'yaml', content: 'just a scalar' })).toMatch(/解析失败/)
    expect(validateOverrideContent({ kind: 'yaml', content: '' })).toMatch(/为空/)
  })
})

describe('OverrideService preview', () => {
  it('returns a redacted preview and is never unavailable against a base', async () => {
    const service = new OverrideService(await makeDir(), () => 0, async () => ({ document: BASE, profileId: 'p1' }))
    await service.create({
      name: '注入凭据',
      kind: 'yaml',
      scope: 'global',
      profileId: null,
      content: 'proxies:\n  - name: p\n    type: socks5\n    server: http://user:secret@example.com\n    port: 80\nproxy-groups:\n  - name: G\n    type: select\n    proxies: [p]\n'
    })
    const preview = await service.preview()
    expect(preview.unavailable).toBe(false)
    expect(preview.appliedText).toContain('***@example.com')
    expect(preview.appliedText).not.toContain('user:secret')
    expect(preview.baseText).toBe(BASE)
  })

  it('reports unavailable when there is no active profile', async () => {
    const service = new OverrideService(await makeDir(), () => 0, async () => null)
    const preview = await service.preview()
    expect(preview.unavailable).toBe(true)
    expect(preview.warnings.length).toBeGreaterThan(0)
  })
})

describe('OverrideService validate', () => {
  it('is valid for a well-formed override on a valid base', async () => {
    const service = new OverrideService(await makeDir(), () => 0, async () => ({ document: BASE, profileId: 'p1' }))
    await service.create({ name: '改mode', kind: 'yaml', scope: 'global', profileId: null, content: 'mode: global' })
    const result = await service.validate()
    expect(result.valid).toBe(true)
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([])
  })

  it('flags a per-item structural failure as an error', async () => {
    const service = new OverrideService(await makeDir(), () => 0, async () => ({ document: BASE, profileId: 'p1' }))
    await service.create({ name: '坏YAML', kind: 'yaml', scope: 'global', profileId: null, content: 'not a map' })
    const result = await service.validate()
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.level === 'error' && i.itemName === '坏YAML')).toBe(true)
  })

  it('flags an override that breaks a previously-valid base', async () => {
    const service = new OverrideService(await makeDir(), () => 0, async () => ({ document: BASE, profileId: 'p1' }))
    await service.create({
      name: '删内容',
      kind: 'js',
      scope: 'global',
      profileId: null,
      content: 'function main(config){ delete config.rules; delete config.proxies; delete config["proxy-groups"]; delete config["proxy-providers"]; return config }'
    })
    const result = await service.validate()
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.level === 'error' && i.itemName === null)).toBe(true)
  })
})

describe('OverrideService last-known-good rollback', () => {
  it('captures and restores a last-known-good override set', async () => {
    const service = new OverrideService(await makeDir(), () => 0, async () => ({ document: BASE, profileId: 'p1' }))
    const first = await service.create({ name: '好', kind: 'yaml', scope: 'global', profileId: null, content: 'mode: global' })
    // Applying a valid result captures this set as last-known-good.
    await service.applyForProfile(BASE, 'p1')
    expect((await service.lastKnownGood())!.snapshot.map((i) => i.name)).toEqual(['好'])

    // A later bad override leaves the applied config without a content section.
    await service.create({
      name: '坏',
      kind: 'js',
      scope: 'global',
      profileId: null,
      content: 'function main(config){ delete config.rules; delete config.proxies; delete config["proxy-groups"]; delete config["proxy-providers"]; return config }'
    })
    await service.applyForProfile(BASE, 'p1')
    // Last-known-good must not be overwritten by the broken config.
    expect((await service.lastKnownGood())!.snapshot.map((i) => i.name)).toEqual(['好'])

    // Rollback restores the good set and drops the breakage.
    const restored = await service.resetToLastGood()
    expect(restored.items.map((i) => i.name)).toEqual(['好'])
  })

  it('returns the current set when no good state has been captured', async () => {
    const service = new OverrideService(await makeDir(), () => 0)
    expect(await service.lastKnownGood()).toBeNull()
    const restored = await service.resetToLastGood()
    expect(restored.items).toEqual([])
  })
})

describe('safety-field ownership', () => {
  it('neutralizes host-network and listener fields injected by an override', async () => {
    const service = new OverrideService(await makeDir(), () => 0)
    const hostile = [
      'external-controller: 0.0.0.0:6666',
      'mixed-port: 44444',
      'allow-lan: true',
      'bind-address: 0.0.0.0',
      'secret: zzz',
      'tun:',
      '  enable: true',
      'listeners:',
      '  - name: evil',
      '    port: 7777',
      'redir-port: 7776',
      'tproxy-port: 7775',
      'dns:',
      '  listen: 0.0.0.0:53',
      '  nameserver: [1.1.1.1]',
      'proxies:',
      '  - name: p',
      '    type: socks5',
      '    server: 1.1.1.1',
      '    port: 80',
      'proxy-groups:',
      '  - name: G',
      '    type: select',
      '    proxies: [p]',
      'rules:',
      '  - MATCH,DIRECT'
    ].join('\n')
    await service.create({ name: '恶意', kind: 'yaml', scope: 'global', profileId: null, content: hostile })

    const applied = await service.applyForProfile(BASE, 'p1')
    // The override really did inject these fields into the runtime copy...
    expect(applied).toContain('0.0.0.0:6666')
    // ...but the safety pass re-owns the loopback-only invariant.
    const safe = buildProfileKernelConfig(applied, {
      mixedPort: 2080,
      controllerPort: 9090,
      secret: 'a'.repeat(64)
    })
    expect(safe).toContain('mixed-port: 2080')
    expect(safe).toContain('127.0.0.1:9090')
    expect(safe).toContain('allow-lan: false')
    expect(safe).toContain('bind-address: 127.0.0.1')
    expect(safe).toContain('secret: ' + 'a'.repeat(64))
    expect(safe).not.toContain('0.0.0.0:6666')
    expect(safe).not.toContain('44444')
    expect(safe).not.toContain('tun:')
    expect(safe).not.toContain('listeners:')
    expect(safe).not.toContain('redir-port:')
    expect(safe).not.toContain('tproxy-port:')
    expect(safe).not.toContain('listen:')
  })
})
