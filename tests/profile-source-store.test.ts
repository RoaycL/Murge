import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EncryptedProfileSourceStore } from '../src/main/profiles/profile-source-store'

describe('EncryptedProfileSourceStore', () => {
  let root = ''
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('persists encrypted bytes and can recover and delete the URL', async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-source-'))
    const store = new EncryptedProfileSourceStore(root, {
      isAvailable: () => true,
      encrypt: (value) => Buffer.from(`cipher:${Buffer.from(value).toString('base64')}`),
      decrypt: (value) => Buffer.from(value.toString().slice(7), 'base64').toString()
    })
    const raw = 'https://example.com/sub?token=supersecret'
    await store.set('p1', raw)
    expect((await readFile(join(root, 'p1.source.enc'))).toString()).not.toContain('supersecret')
    expect(await store.get('p1')).toBe(raw)
    await store.delete('p1')
    expect(await store.get('p1')).toBeNull()
  })

  it('fails closed when secure storage is unavailable', async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-source-'))
    const store = new EncryptedProfileSourceStore(root, {
      isAvailable: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => ''
    })
    await expect(store.set('p1', 'https://example.com')).rejects.toThrow(/安全存储不可用/)
  })
})
