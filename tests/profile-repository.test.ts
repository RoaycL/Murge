import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileRepository, applyEdits } from '../src/main/profiles/profile-repository'
import { createConfigValidator } from '../src/main/profiles/config-validator'
import type { ProfileSubscription } from '../src/shared/profiles'

const MANUAL_SOURCE: ProfileSubscription = { type: 'manual' }

const VALID_DOC = `# my proxy config
mixed-port: 7890
# proxies list
proxies:
  - name: node-01
    server: 127.0.0.1
proxy-groups:
  - name: G
    type: select
    proxies: [ node-01 ]
rules:
  - MATCH,DIRECT
`

describe('ProfileRepository', () => {
  let rootDir: string
  let repository: ProfileRepository
  let counter: number

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'profile-repo-'))
    counter = 0
    repository = new ProfileRepository({
      rootDir,
      validator: createConfigValidator(),
      idGenerator: () => `p${(counter += 1)}`,
      now: () => 1000
    })
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('imports a profile and lists it as inactive', async () => {
    const meta = await repository.import('my config', VALID_DOC, MANUAL_SOURCE, false)
    expect(meta.id).toBe('p1')
    expect(meta.active).toBe(false)
    const list = await repository.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('my config')
    expect(list[0].active).toBe(false)
  })

  it('marks a profile active when imported with activate=true', async () => {
    const meta = await repository.import('cfg', VALID_DOC, MANUAL_SOURCE, true)
    expect(meta.active).toBe(true)
    const list = await repository.list()
    expect(list[0].active).toBe(true)
  })

  it('rejects a duplicate name case-insensitively', async () => {
    await repository.import('My Config', VALID_DOC, MANUAL_SOURCE, false)
    await expect(repository.import('my config', VALID_DOC, MANUAL_SOURCE, false)).rejects.toThrow(/already exists/i)
  })

  it('gets a profile by id and returns its verbatim document', async () => {
    const meta = await repository.import('cfg', VALID_DOC, MANUAL_SOURCE, false)
    const profile = await repository.get(meta.id)
    expect(profile.document).toBe(VALID_DOC)
    expect(profile.meta.id).toBe(meta.id)
  })

  it('throws NOT_FOUND for a missing profile', async () => {
    await expect(repository.get('nope')).rejects.toThrow(/not found/i)
  })

  it('deletes a profile and clears the active pointer when the active profile is deleted', async () => {
    const meta = await repository.import('cfg', VALID_DOC, MANUAL_SOURCE, true)
    expect((await repository.list())[0].active).toBe(true)
    await repository.delete(meta.id)
    expect(await repository.list()).toHaveLength(0)
  })

  it('renames a profile and rejects renaming onto an existing name', async () => {
    const a = await repository.import('a', VALID_DOC, MANUAL_SOURCE, false)
    await repository.import('b', VALID_DOC, MANUAL_SOURCE, false)
    const renamed = await repository.rename(a.id, 'A New Name')
    expect(renamed.name).toBe('A New Name')
    await expect(repository.rename(a.id, 'b')).rejects.toThrow(/already exists/i)
  })

  it('rejects an id that could traverse the directory', async () => {
    await expect(repository.get('../../x')).rejects.toThrow(/invalid characters/i)
    await expect(repository.get('a/b')).rejects.toThrow(/invalid characters/i)
  })

  it('leaves no temp files behind after an atomic write', async () => {
    await repository.import('cfg', VALID_DOC, MANUAL_SOURCE, true)
    const files = await readdir(rootDir)
    expect(files.some((name) => name.startsWith('.tmp-'))).toBe(false)
  })

  it('preserves unknown keys and comments during a supported scalar edit', async () => {
    const meta = await repository.import('cfg', VALID_DOC, MANUAL_SOURCE, true)
    await repository.editDocument(meta.id, [{ key: 'mixed-port', value: '8888' }])
    const updated = await repository.get(meta.id)
    expect(updated.document).toContain('# my proxy config')
    expect(updated.document).toContain('# proxies list')
    expect(updated.document).toContain('mixed-port: 8888')
    expect(updated.document).toContain('proxies:\n  - name: node-01')
  })
})

describe('applyEdits', () => {
  it('does not drop an inline comment when replacing a value', () => {
    const doc = 'mode: rule  # outbound mode\nport: 1\n'
    const out = applyEdits(doc, [{ key: 'mode', value: 'global' }])
    expect(out).toContain('# outbound mode')
    expect(out).toContain('mode: global')
  })

  it('inserts a missing top-level key at the end', () => {
    const doc = 'port: 1\n'
    const out = applyEdits(doc, [{ key: 'mode', value: 'rule' }])
    expect(out).toContain('port: 1')
    expect(out).toContain('mode: rule')
  })

  it('does not clobber a nested element sharing the key name', () => {
    const doc = 'port: 1\nproxy-groups:\n  - name: mode\n    type: select\n'
    const out = applyEdits(doc, [{ key: 'mode', value: 'global' }])
    expect(out).toContain('- name: mode')
    expect(out).toContain('mode: global')
  })
})
