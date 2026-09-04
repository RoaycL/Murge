import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileRepository } from '../src/main/profiles/profile-repository'
import { ProfileService } from '../src/main/profiles/profile-service'
import { createConfigValidator } from '../src/main/profiles/config-validator'
import { SubscriptionFetcher } from '../src/main/subscriptions/subscription-fetcher'
import { MemoryProfileSourceStore } from '../src/main/profiles/profile-source-store'

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

  it('never writes a credential to the meta file on disk (import path)', async () => {
    // Regression guard: assert the RAW persisted bytes, not just the returned
    // meta. A previous design kept a full-credential `url` on disk while only the
    // display copy was redacted, which the return-value assertions above missed.
    const meta = await service.importProfile({
      name: 'creds',
      document: VALID_DOC,
      source: { type: 'url', url: 'https://user:supersecret@example.com/sub?token=TOK123' }
    })
    const raw = await readFile(join(rootDir, `${meta.id}.meta.json`), 'utf8')
    expect(raw).not.toContain('supersecret')
    expect(raw).not.toContain('TOK123')
    // And what the renderer receives via listProfiles must be clean too.
    const listed = JSON.stringify(await service.listProfiles())
    expect(listed).not.toContain('supersecret')
    expect(listed).not.toContain('TOK123')
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

  describe('subscription naming and updateFromSource', () => {
    function fetcherReturning(suggestedName: string | null, document = VALID_DOC) {
      return new SubscriptionFetcher({
        fetchFn: async () => ({
          ok: true,
          status: 200,
          headers: {
            has: () => suggestedName !== null,
            get: () => (suggestedName !== null ? `attachment; filename="${suggestedName}.yaml"` : null)
          },
          text: async () => document
        })
      })
    }

    it('derives the profile name from the response filename when the caller leaves it empty', async () => {
      const derived = new ProfileService(repository, createConfigValidator(), fetcherReturning('机场订阅'))
      const meta = await derived.importFromUrl('', 'https://example.com/sub')
      expect(meta.name).toBe('机场订阅')
    })

    it('falls back to the URL host and then the default label', async () => {
      const noHeader = new ProfileService(repository, createConfigValidator(), fetcherReturning(null))
      const byHost = await noHeader.importFromUrl('', 'https://airport.example.com/sub')
      expect(byHost.name).toBe('airport.example.com')

      const unparseable = new ProfileService(repository, createConfigValidator(), fetcherReturning(null))
      const fallback = await unparseable.importFromUrl('', 'https://a/b', false)
      expect(fallback.name.length).toBeGreaterThan(0)
      expect(fallback.name).not.toContain('https://')
    })

    it('keeps an explicit caller-provided name untouched', async () => {
      const explicit = new ProfileService(repository, createConfigValidator(), fetcherReturning('suggested'))
      const meta = await explicit.importFromUrl('我的名字', 'https://example.com/sub')
      expect(meta.name).toBe('我的名字')
    })

    it('updateFromSource re-fetches the subscription and replaces the document, keeping name and pointer', async () => {
      const original = await service.importProfile({ name: 'sub', document: VALID_DOC, source: { type: 'url', url: 'https://example.com/sub' }, activate: true })
      const updater = new ProfileService(repository, createConfigValidator(), fetcherReturning('sub', `mixed-port: 7890\nproxies:\n  - name: fresh\n    server: 127.0.0.1\n`))
      const updated = await updater.updateFromSource(original.id)
      expect(updated.name).toBe('sub')
      const profile = await repository.get(original.id)
      expect(profile.document).toContain('name: fresh')
      expect(profile.document).not.toContain('name: node-01')
      expect((await repository.list()).find((meta) => meta.active)?.id).toBe(original.id)
    })

    it('updates a token-bearing subscription with its private raw URL', async () => {
      const sourceStore = new MemoryProfileSourceStore()
      const seen: string[] = []
      const fetcher = new SubscriptionFetcher({
        fetchFn: async (url) => {
          seen.push(String(url))
          return { ok: true, status: 200, text: async () => VALID_DOC }
        }
      })
      const remote = new ProfileService(repository, createConfigValidator(), fetcher, sourceStore)
      const rawUrl = 'https://gist.githubusercontent.com/RoaycL/8bb169258b029784d6a534b23b92cc8e/raw/MihomoParty'
      const meta = await remote.importFromUrl('gist', rawUrl)
      expect(meta.source.url).toContain('[UUID_REDACTED]')
      expect(meta.source.url).not.toContain('8bb169258b029784d6a534b23b92cc8e')
      await remote.updateFromSource(meta.id)
      expect(seen).toEqual([rawUrl, rawUrl])
      expect(JSON.stringify(await remote.listProfiles())).not.toContain('8bb169258b029784d6a534b23b92cc8e')
    })

    it('removes the private refresh URL when a profile is deleted', async () => {
      const sourceStore = new MemoryProfileSourceStore()
      const remote = new ProfileService(repository, createConfigValidator(), fetcherReturning(null), sourceStore)
      const meta = await remote.importFromUrl('sub', 'https://example.com/private?token=secret')
      expect(await sourceStore.get(meta.id)).not.toBeNull()
      await remote.deleteProfile(meta.id)
      expect(await sourceStore.get(meta.id)).toBeNull()
    })

    it('updateFromSource rejects a profile without a remote source', async () => {
      const manual = await service.importProfile({ name: 'local', document: VALID_DOC, source: { type: 'manual' } })
      await expect(service.updateFromSource(manual.id)).rejects.toThrow(/没有远程订阅地址/)
    })

    it('updateFromSource does not write an update whose document fails validation', async () => {
      const original = await service.importProfile({ name: 'sub', document: VALID_DOC, source: { type: 'url', url: 'https://example.com/sub' } })
      const badFetcher = new SubscriptionFetcher({
        fetchFn: async () => ({ ok: true, status: 200, text: async () => INVALID_DOC })
      })
      const breaker = new ProfileService(repository, createConfigValidator(), badFetcher)
      await expect(breaker.updateFromSource(original.id)).rejects.toThrow(/配置校验失败/i)
      const profile = await repository.get(original.id)
      expect(profile.document).toContain('name: node-01')
    })
  })
})
