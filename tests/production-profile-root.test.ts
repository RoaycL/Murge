import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { brand } from '@shared/brand'
import {
  APP_DATA_NAMESPACE,
  PROFILES_SUBDIR,
  appDataRoot,
  profilesRoot,
  resolveRuntimeProfileRoot
} from '../src/main/storage/app-data'
import { ProfileRepository } from '../src/main/profiles/profile-repository'
import { createConfigValidator } from '../src/main/profiles/config-validator'
import type { ProfileSubscription } from '../src/shared/profiles'

const MANUAL_SOURCE: ProfileSubscription = { type: 'manual' }

const VALID_DOC = `mixed-port: 7890
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

describe('runtime profile root resolution', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'profile-root-base-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('resolves the production profile root to a stable, product-name-free namespace', async () => {
    const root = await resolveRuntimeProfileRoot(base, { dev: false })

    expect(root).toBe(profilesRoot(base))
    // Exactly one appId segment, never a doubled namespace
    // (io.murge.desktop/io.murge.desktop/profiles).
    expect(root).toBe(join(base, APP_DATA_NAMESPACE, PROFILES_SUBDIR))
    expect(root).toBe(join(appDataRoot(base), PROFILES_SUBDIR))
    // The durable namespace is derived from appId, never the cosmetic product name.
    expect(root).not.toContain(brand.productName)
    // The directory itself is created eagerly.
    expect((await stat(root)).isDirectory()).toBe(true)
  })

  it('returns the same production root across repeated resolution (two builds share storage)', async () => {
    const first = await resolveRuntimeProfileRoot(base, { dev: false })
    const second = await resolveRuntimeProfileRoot(base, { dev: false })
    expect(second).toBe(first)
  })

  it('keeps development builds in an isolated temp workspace', async () => {
    const first = await resolveRuntimeProfileRoot(base, { dev: true })
    const second = await resolveRuntimeProfileRoot(base, { dev: true })

    // Dev never writes into the app-data namespace base.
    expect(first).not.toBe(profilesRoot(base))
    expect(first.startsWith(base)).toBe(false)
    expect(first.startsWith(tmpdir())).toBe(true)
    expect(second).not.toBe(first) // fresh mkdtemp per launch
    expect((await stat(first)).isDirectory()).toBe(true)
  })

  it('persists a profile written to the production root across a repository recreation', async () => {
    const root = await resolveRuntimeProfileRoot(base, { dev: false })
    const validator = createConfigValidator()

    const first = new ProfileRepository({ rootDir: root, validator: createConfigValidator() })
    await first.import('prod config', VALID_DOC, MANUAL_SOURCE, false)

    // A second build resolves the same directory and constructs a fresh
    // repository; the previously-written profile must still be readable.
    const again = await resolveRuntimeProfileRoot(base, { dev: false })
    expect(again).toBe(root)
    const second = new ProfileRepository({ rootDir: again, validator })
    const list = await second.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('prod config')
  })
})
