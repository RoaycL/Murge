import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SubStoreService, type SubStoreWorkerHandle } from '../src/main/substore/service'
import type { AppSettingsGateway } from '@shared/gateways'
import type { AppSettings } from '@shared/app-settings'
import { DEFAULT_APP_SETTINGS } from '@shared/app-settings'
import { buildTestZip } from './helpers/substore-zip-builder'

class FakeSettings implements AppSettingsGateway {
  settings: AppSettings = { ...DEFAULT_APP_SETTINGS }
  async get(): Promise<AppSettings> {
    return { ...this.settings }
  }
  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch }
    return { ...this.settings }
  }
  onChange(): () => void {
    return () => {}
  }
}

interface FakeWorker {
  handle: SubStoreWorkerHandle
  env: Record<string, string>
  bundlePath: string
  crash: (error: Error) => void
}

function okResponse(body: string | Buffer): Response {
  return new Response(body, { status: 200 })
}

const BACKEND_BODY = Buffer.from('BUNDLE')
const FRONTEND_BODY = buildTestZip([
  { name: 'dist/index.html', data: Buffer.from('<html>Sub-Store</html>') },
  { name: 'dist/assets/app.js', data: Buffer.from('export default 1') }
])

function releaseResponse(
  repo: 'backend' | 'frontend',
  tag: string,
  body = repo === 'backend' ? BACKEND_BODY : FRONTEND_BODY,
  digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
): Response {
  const name = repo === 'backend' ? 'sub-store.bundle.js' : 'dist.zip'
  const base = repo === 'backend'
    ? 'https://github.com/sub-store-org/Sub-Store'
    : 'https://github.com/sub-store-org/Sub-Store-Front-End'
  return okResponse(JSON.stringify({
    tag_name: tag,
    assets: [{
      name,
      size: body.length,
      digest,
      browser_download_url: `${base}/releases/download/${tag}/${name}`
    }]
  }))
}

function makeFetch(overrides: Record<string, Response | Error> = {}): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const override = overrides[url]
    if (override instanceof Error) throw override
    if (override) return override
    if (url.includes('api.github.com/repos/sub-store-org/Sub-Store-Front-End/')) {
      const tag = url.includes('/tags/') ? url.split('/tags/')[1] : '2.31.2'
      return releaseResponse('frontend', tag)
    }
    if (url.includes('api.github.com/repos/sub-store-org/Sub-Store/')) {
      const tag = url.includes('/tags/') ? url.split('/tags/')[1] : '2.38.2'
      return releaseResponse('backend', tag)
    }
    if (url.includes('sub-store.bundle.js')) return okResponse(BACKEND_BODY)
    if (url.includes('dist.zip')) return okResponse(FRONTEND_BODY)
    // Health endpoint and everything else.
    return okResponse('<html>Sub-Store</html>')
  }) as unknown as typeof fetch
}

async function setup() {
  const baseDir = await mkdtemp(join(tmpdir(), 'substore-svc-'))
  return baseDir
}

describe('SubStoreService', () => {
  let baseDir: string
  let settings: FakeSettings

  beforeEach(async () => {
    baseDir = await setup()
    settings = new FakeSettings()
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  function makeService(
    opts: {
      fetch?: typeof fetch
      getMixedPort?: () => number | null
      workers?: FakeWorker[]
      portInUse?: number[]
      delay?: (ms: number) => Promise<void>
    } = {}
  ): SubStoreService {
    const workers = opts.workers ?? []
    const usedPorts = new Set(opts.portInUse ?? [])
    const service = new SubStoreService({
      baseDir,
      brandName: 'TestShell',
      appSettings: settings,
      getMixedPort: opts.getMixedPort ?? (() => null),
      fetchFn: opts.fetch ?? makeFetch(),
      createWorker: (bundlePath, env) => {
        const crashCallbacks: Array<(error: Error) => void> = []
        const worker: FakeWorker = {
          bundlePath,
          env,
          crash: (error) => crashCallbacks.forEach((cb) => cb(error)),
          handle: {
            terminate: async () => {
              workers.splice(workers.indexOf(worker), 1)
              return 0
            },
            onUnexpectedExit: (cb) => crashCallbacks.push(cb)
          }
        }
        workers.push(worker)
        return worker.handle
      },
      findFreePort: async (base) => {
        let candidate = base
        while (usedPorts.has(candidate)) candidate++
        return candidate
      },
      delay: opts.delay ?? (async () => {}),
      pinnedDigests: {
        backend: `sha256:${createHash('sha256').update(BACKEND_BODY).digest('hex')}`,
        frontend: `sha256:${createHash('sha256').update(FRONTEND_BODY).digest('hex')}`
      }
    })
    // Health check: fail while `starting` unless the fetch override says OK.
    return service
  }

  it('downloads pinned assets on first ensure and reports ready state', async () => {
    const service = makeService()
    settings.settings.subStoreEnabled = true
    const state = await service.ensureRunning()
    expect(state.phase).toBe('running')
    expect(state.assetsReady).toBe(true)
    expect(state.version).toEqual({ backend: '2.38.2', frontend: '2.31.2' })
    expect(state.port).toBe(38324)
    expect(state.error).toBeNull()
    // Bundle + frontend index on disk; versions marker persisted.
    expect(await readFile(join(baseDir, 'assets/sub-store.bundle.cjs'), 'utf8')).toBe('BUNDLE')
    expect(await readFile(join(baseDir, 'assets/sub-store-frontend/index.html'), 'utf8')).toBe(
      '<html>Sub-Store</html>'
    )
    await service.dispose()
  })

  it('configures merge mode on one loopback port and never inherits env', async () => {
    const workers: FakeWorker[] = []
    const service = makeService({ workers })
    settings.settings.subStoreEnabled = true
    await service.ensureRunning()
    expect(workers).toHaveLength(1)
    const env = workers[0].env
    expect(env.SUB_STORE_BACKEND_API_HOST).toBe('127.0.0.1')
    expect(env.SUB_STORE_BACKEND_MERGE).toBe('1')
    expect(env.SUB_STORE_FRONTEND_PATH).toBe(join(baseDir, 'assets/sub-store-frontend'))
    expect(env.SUB_STORE_FRONTEND_BACKEND_PATH).toBe('/')
    expect(env.SUB_STORE_DATA_BASE_PATH).toContain('data')
    expect(env.HTTP_PROXY).toBeUndefined()
    await service.dispose()
  })

  it('routes worker egress through the kernel mixed-port only when useProxy is on', async () => {
    const workers: FakeWorker[] = []
    const service = makeService({ workers, getMixedPort: () => 11984 })
    settings.settings.subStoreEnabled = true
    settings.settings.subStoreUseProxy = true
    await service.ensureRunning()
    expect(workers[0].env.HTTP_PROXY).toBe('http://127.0.0.1:11984')
    expect(workers[0].env.HTTPS_PROXY).toBe('http://127.0.0.1:11984')
    await service.dispose()
  })

  it('skips re-download when assets and versions already match', async () => {
    const calls: string[] = []
    const fetchSpy = makeFetch()
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input))
      return fetchSpy(input, init)
    }) as unknown as typeof fetch
    const service = makeService({ fetch: wrapped })
    settings.settings.subStoreEnabled = true
    await service.ensureRunning()
    calls.length = 0
    // Second ensure: worker restarts but nothing is re-downloaded.
    await service.stop()
    await service.ensureRunning()
    expect(calls.filter((url) => url.includes('github')).length).toBe(0)
    await service.dispose()
  })

  it('surfaces download failure as error state with a persisted-off store', async () => {
    const service = makeService({
      fetch: makeFetch({
        'https://github.com/sub-store-org/Sub-Store/releases/download/2.38.2/sub-store.bundle.js':
          new Error('connection reset')
      })
    })
    settings.settings.subStoreEnabled = true
    const state = await service.ensureRunning()
    expect(state.phase).toBe('error')
    expect(state.error).toContain('下载失败')
    expect(state.port).toBeNull()
    await service.dispose()
  })

  it('marks error phase when the worker exits during startup', async () => {
    const workers: FakeWorker[] = []
    // First health probe fails so the crash has a window to register between
    // polls (the healthy reply would otherwise win the race deterministically).
    let healthCalls = 0
    const inner = makeFetch()
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'http://127.0.0.1:38324/') {
        healthCalls++
        if (healthCalls === 1) throw new Error('not listening yet')
      }
      return inner(input, init)
    }) as unknown as typeof fetch
    // Gate the inter-poll delay so the crash lands between probes regardless
    // of microtask timing.
    let releasePollGate: () => void = () => {}
    const pollGate = new Promise<void>((resolvePromise) => {
      releasePollGate = resolvePromise
    })
    let pollGatesUsed = 0
    const delay = async (): Promise<void> => {
      if (pollGatesUsed++ === 0) await pollGate
    }
    const service = makeService({ workers, fetch: fetchFn, delay })
    settings.settings.subStoreEnabled = true
    const promise = service.ensureRunning()
    await vi.waitFor(() => {
      if (healthCalls < 1) throw new Error('first health probe not attempted')
    })
    workers[0]?.crash(new Error('SIGKILL'))
    releasePollGate()
    const state = await promise
    expect(state.phase).toBe('error')
    expect(state.error).toContain('SIGKILL')
    await service.dispose()
  })

  it('stop() terminates the worker and clears the port but keeps assets', async () => {
    const workers: FakeWorker[] = []
    const service = makeService({ workers })
    settings.settings.subStoreEnabled = true
    await service.ensureRunning()
    expect(workers).toHaveLength(1)
    const state = await service.stop()
    expect(state.phase).toBe('idle')
    expect(state.port).toBeNull()
    expect(workers).toHaveLength(0)
    expect(state.assetsReady).toBe(true)
    await service.dispose()
  })

  it('checkUpdate re-downloads when the upstream tag moved', async () => {
    const service = makeService()
    settings.settings.subStoreEnabled = true
    await service.ensureRunning()
    const newer = makeFetch({
      'https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest': releaseResponse('backend', '2.39.0')
    })
    // Replace the fetch strategy by constructing a second service sharing the dir.
    const service2 = new SubStoreService({
      baseDir,
      brandName: 'TestShell',
      appSettings: settings,
      getMixedPort: () => null,
      fetchFn: newer,
      createWorker: () => ({
        terminate: async () => 0,
        onUnexpectedExit: () => {}
      }),
      findFreePort: async (base) => base,
      delay: async () => {}
    })
    const state = await service2.checkUpdate()
    expect(state.version?.backend).toBe('2.39.0')
    // This service never started a worker, so the updated assets stay idle.
    expect(state.phase).toBe('idle')
    // The next ensure picks the updated bundle up without a further download.
    const running = await service2.ensureRunning()
    expect(running.phase).toBe('running')
    expect(running.version?.backend).toBe('2.39.0')
    await service2.dispose()
  })

  it('single-flights concurrent ensure calls', async () => {
    const service = makeService()
    settings.settings.subStoreEnabled = true
    const [a, b] = await Promise.all([service.ensureRunning(), service.ensureRunning()])
    expect(a.port).toBe(b.port)
    expect(a.phase).toBe('running')
    await service.dispose()
  })

  it('snapshot mirrors the PERSISTED settings even before any settings change', async () => {
    // Regression: the first read on page open used to hardcode enabled=false,
    // so a persisted-on store rendered the switch off and blocked auto-start.
    const service = makeService()
    settings.settings.subStoreEnabled = true
    settings.settings.subStoreUseProxy = true
    const state = await service.snapshot()
    expect(state.enabled).toBe(true)
    expect(state.useProxy).toBe(true)
    await service.dispose()
  })

  it('restores the running phase when checkUpdate fails mid-download', async () => {
    // Regression: a failed update while running used to leave the phase stuck
    // on 'downloading' forever (worker was never stopped on that path).
    let currentFetch = makeFetch()
    const service = makeService({
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => currentFetch(input, init)) as typeof fetch
    })
    settings.settings.subStoreEnabled = true
    await service.ensureRunning()
    // The GitHub latest-tag lookup now fails on the SAME running service.
    currentFetch = makeFetch({
      'https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest': new Error('rate limited')
    })
    const state = await service.checkUpdate()
    expect(state.error).toContain('rate limited')
    expect(state.phase).toBe('running')
    expect(state.port).not.toBeNull()
    await service.dispose()
  })

  it('does not restart a running worker for unrelated settings notifications', async () => {
    const workers: FakeWorker[] = []
    const service = makeService({ workers })
    settings.settings.subStoreEnabled = true
    await service.ensureRunning()
    const first = workers[0]

    await service.onSettings({ subStoreEnabled: true, subStoreUseProxy: false })
    expect(workers).toHaveLength(1)
    expect(workers[0]).toBe(first)

    settings.settings.subStoreUseProxy = true
    await service.onSettings({ subStoreEnabled: true, subStoreUseProxy: true })
    expect(workers).toHaveLength(1)
    expect(workers[0]).not.toBe(first)
    expect(workers[0].env.HTTP_PROXY).toBeUndefined()
    await service.dispose()
  })

  it('keeps the worker stopped when disabled during the initial download', async () => {
    const workers: FakeWorker[] = []
    const inner = makeFetch()
    let releaseDownload!: () => void
    const gate = new Promise<void>((resolvePromise) => { releaseDownload = resolvePromise })
    let downloadStarted = false
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('sub-store.bundle.js')) {
        downloadStarted = true
        await gate
      }
      return inner(input, init)
    }) as typeof fetch
    const service = makeService({ workers, fetch: fetchFn })
    settings.settings.subStoreEnabled = true
    const starting = service.ensureRunning()
    await vi.waitFor(() => {
      if (!downloadStarted) throw new Error('download not started')
    })

    settings.settings.subStoreEnabled = false
    const stopping = service.onSettings({ subStoreEnabled: false, subStoreUseProxy: false })
    releaseDownload()
    await Promise.all([starting, stopping])
    const state = await service.snapshot()
    expect(state.enabled).toBe(false)
    expect(state.phase).toBe('idle')
    expect(state.port).toBeNull()
    expect(workers).toHaveLength(0)
    await service.dispose()
  })

  it('rejects a downloaded backend whose SHA-256 differs from release metadata', async () => {
    const badDigest = `sha256:${'0'.repeat(64)}`
    const service = makeService({
      fetch: makeFetch({
        'https://api.github.com/repos/sub-store-org/Sub-Store/releases/tags/2.38.2':
          releaseResponse('backend', '2.38.2', BACKEND_BODY, badDigest)
      })
    })
    settings.settings.subStoreEnabled = true
    const state = await service.ensureRunning()
    expect(state.phase).toBe('error')
    expect(state.error).toContain('摘要')
    expect(state.assetsReady).toBe(false)
    await service.dispose()
  })

  it('keeps the complete old asset set when a multi-asset update fails', async () => {
    let currentFetch = makeFetch()
    const service = makeService({
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => currentFetch(input, init)) as typeof fetch
    })
    settings.settings.subStoreEnabled = true
    await service.ensureRunning()

    const nextBackend = Buffer.from('NEW-BUNDLE')
    currentFetch = makeFetch({
      'https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest':
        releaseResponse('backend', '2.39.0', nextBackend),
      'https://api.github.com/repos/sub-store-org/Sub-Store-Front-End/releases/latest':
        releaseResponse('frontend', '2.32.0'),
      'https://api.github.com/repos/sub-store-org/Sub-Store/releases/tags/2.39.0':
        releaseResponse('backend', '2.39.0', nextBackend),
      'https://api.github.com/repos/sub-store-org/Sub-Store-Front-End/releases/tags/2.32.0':
        releaseResponse('frontend', '2.32.0'),
      'https://github.com/sub-store-org/Sub-Store/releases/download/2.39.0/sub-store.bundle.js':
        okResponse(nextBackend),
      'https://github.com/sub-store-org/Sub-Store-Front-End/releases/download/2.32.0/dist.zip':
        new Error('frontend unavailable')
    })
    const state = await service.checkUpdate()
    expect(state.phase).toBe('running')
    expect(state.error).toContain('frontend unavailable')
    expect(state.version).toEqual({ backend: '2.38.2', frontend: '2.31.2' })
    expect(await readFile(join(baseDir, 'assets/sub-store.bundle.cjs'), 'utf8')).toBe('BUNDLE')
    await service.dispose()
  })
})
