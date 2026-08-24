import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileRepository } from '../src/main/profiles/profile-repository'
import { ProfileService } from '../src/main/profiles/profile-service'
import { createConfigValidator } from '../src/main/profiles/config-validator'
import { SubscriptionFetcher } from '../src/main/subscriptions/subscription-fetcher'

const VALID_DOC = `mixed-port: 7890
proxies:
  - name: node-01
    server: 127.0.0.1
rules:
  - MATCH,DIRECT
`

const INVALID_DOC = 'proxies: [\n  - name: node-01\n'

describe('ProfileService', () => {
  let rootDir: string
  let repository: ProfileRepository
  let service: ProfileService

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'profile-service-'))
    let idCounter = 0
    repository = new ProfileRepository({
      rootDir,
      validator: createConfigValidator(),
      idGenerator: () => `p${(idCounter += 1)}`,
      now: () => 1000
    })
    service = new ProfileService(repository, createConfigValidator(), new SubscriptionFetcher({ maxBytes: 1024 }))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('imports a valid manual profile when activate is false', async () => {
    const meta = await service.importProfile({ name: 'cfg', document: VALID_DOC, source: { type: 'manual' } })
    expect(meta.name).toBe('cfg')
    expect(meta.active).toBe(false)
  })

  it('rejects an invalid YAML document at import time (failed start leaves active unchanged)', async () => {
    await service.importProfile({ name: 'good', document: VALID_DOC, source: { type: 'manual' }, activate: true })
    await expect(
      service.importProfile({ name: 'bad', document: INVALID_DOC, source: { type: 'manual' } })
    ).rejects.toThrow(/配置校验失败/i)
    const list = await service.listProfiles()
    // The invalid profile must not have been created (no partial import).
    expect(list.some((meta) => meta.name === 'bad')).toBe(false)
    // The originally active profile stays active.
    expect(list.find((meta) => meta.active)?.name).toBe('good')
  })

  it('does not activate a profile whose validation fails (exit criterion)', async () => {
    const good = await service.importProfile({ name: 'good', document: VALID_DOC, source: { type: 'manual' }, activate: true })
    // Store a structurally invalid profile directly, bypassing import-time validation,
    // then attempt activation — it must be rejected and leave the active profile intact.
    await repository.import('ghost', INVALID_DOC, { type: 'manual' }, false)
    const ghost = (await repository.list()).find((meta) => meta.name === 'ghost')
    expect(ghost).toBeDefined()
    await expect(service.activateProfile(ghost!.id)).rejects.toThrow(/配置校验失败/i)
    const list = await service.listProfiles()
    expect(list.find((meta) => meta.active)?.id).toBe(good.id)
  })

  it('activates a valid profile', async () => {
    await service.importProfile({ name: 'good', document: VALID_DOC, source: { type: 'manual' } })
    const list = await service.listProfiles()
    const meta = await service.activateProfile(list[0].id)
    expect(meta.active).toBe(true)
    expect((await service.listProfiles())[0].active).toBe(true)
  })

  it('surfaces a failed subscription fetch without leaving an active profile', async () => {
    const serviceWithFailingFetch = new ProfileService(
      repository,
      createConfigValidator(),
      new SubscriptionFetcher({
        maxBytes: 1024,
        fetchFn: async () => { throw new Error('ECONNREFUSED') }
      })
    )
    await expect(
      serviceWithFailingFetch.importFromUrl('sub', 'https://user:secret@example.com/x')
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNREACHABLE' })
    expect(await service.listProfiles()).toHaveLength(0)
  })

  it('imports a subscription and persists only the redacted URL', async () => {
    const serviceWithFetch = new ProfileService(
      repository,
      createConfigValidator(),
      new SubscriptionFetcher({
        maxBytes: 1024,
        fetchFn: async () => ({ ok: true, status: 200, text: async () => VALID_DOC })
      })
    )
    const meta = await serviceWithFetch.importFromUrl('sub', 'https://user:secret@example.com/x')
    expect(meta.source.url).toBe('https://redacted@example.com/x')
    expect(meta.source.url).not.toContain('secret')
  })

  it('rejects an invalid subscription document (HTTP 200 but malformed body)', async () => {
    const serviceWithFetch = new ProfileService(
      repository,
      createConfigValidator(),
      new SubscriptionFetcher({
        maxBytes: 1024,
        fetchFn: async () => ({ ok: true, status: 200, text: async () => INVALID_DOC })
      })
    )
    await expect(serviceWithFetch.importFromUrl('sub', 'https://example.com/x')).rejects.toThrow(/配置校验失败/i)
    expect(await repository.list()).toHaveLength(0)
  })

  it('applies supported document edits and re-validates the result', async () => {
    const meta = await service.importProfile({ name: 'cfg', document: VALID_DOC, source: { type: 'manual' } })
    const updated = await service.editDocument(meta.id, [{ key: 'mixed-port', value: '8888' }])
    expect(updated.updatedAt).toBe(1000)
    const profile = await service.getProfile(meta.id)
    expect(profile.document).toContain('mixed-port: 8888')
    expect(profile.document).toContain('proxies:\n  - name: node-01')
  })

  it('does not persist an edit whose result fails validation', async () => {
    // A validator that rejects any document setting mixed-port to the forbidden
    // value, so the edit preview is rejected before it reaches disk.
    const strictValidator = {
      validate: (document: string) =>
        document.includes('mixed-port: 9090')
          ? { ok: false, issues: [{ severity: 'error' as const, message: 'forbidden port' }] }
          : { ok: true, issues: [] }
    }
    const strictService = new ProfileService(repository, strictValidator, new SubscriptionFetcher({ maxBytes: 1024 }))
    const meta = await strictService.importProfile({ name: 'cfg', document: VALID_DOC, source: { type: 'manual' } })
    await expect(
      strictService.editDocument(meta.id, [{ key: 'mixed-port', value: '9090' }])
    ).rejects.toThrow(/配置校验失败/i)
    const profile = await repository.get(meta.id)
    expect(profile.document).toContain('mixed-port: 7890')
    expect(profile.document).not.toContain('mixed-port: 9090')
  })

  it('rename throws a duplicate-name error', async () => {
    await service.importProfile({ name: 'a', document: VALID_DOC, source: { type: 'manual' } })
    await service.importProfile({ name: 'b', document: VALID_DOC, source: { type: 'manual' } })
    const list = await service.listProfiles()
    await expect(service.renameProfile(list[0].id, 'b')).rejects.toThrow(/already exists/i)
  })
})
