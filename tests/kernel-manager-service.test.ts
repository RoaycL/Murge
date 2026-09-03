import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { KernelManagerService } from '../src/main/kernel/kernel-manager-service'
import { FakeAppSettingsGateway } from '../src/main/testing/fake-container'
import type { MihomoAsset, MihomoReleaseAsset, ResolvedMihomoBinary } from '../src/main/kernel/mihomo-artifact'

async function makeService(overrides?: {
  versions?: string[]
  assets?: (version: string) => Promise<MihomoReleaseAsset[]>
}): Promise<{ service: KernelManagerService; settings: FakeAppSettingsGateway; base: string }> {
  const base = await mkdtemp(join(tmpdir(), 'kernel-manager-'))
  const settings = new FakeAppSettingsGateway()
  const service = new KernelManagerService({
    settings,
    workspaceRoot: join(base, 'kernel'),
    platform: 'win32',
    arch: 'amd64',
    stableVersion: 'v1.19.30',
    fetchVersions: async () => overrides?.versions ?? ['v1.19.30', 'v1.19.20', 'v1.19.11'],
    fetchReleaseAssets: async (version) =>
      overrides?.assets
        ? overrides.assets(version)
        : [
            {
              name: `mihomo-windows-amd64-${version}.zip`,
              digest: `sha256:${'a'.repeat(64)}`,
              size: 1000,
              browser_download_url: `https://example.com/${version}.zip`
            }
          ],
    resolveAsset: async (asset: MihomoAsset, workspaceDir: string): Promise<ResolvedMihomoBinary> => {
      return {
        path: join(workspaceDir, 'mihomo.exe'),
        version: asset.version?.replace(/^v/, '') ?? '1.19.30',
        asset,
        sha256: asset.sha256,
        url: asset.url,
        reused: false
      }
    }
  })
  return { service, settings, base }
}

describe('KernelManagerService', () => {
  describe('state', () => {
    it('defaults to stable, enabled, with the stable version effective', async () => {
      const { service, base } = await makeService()
      const state = await service.getState()
      expect(state.enabled).toBe(true)
      expect(state.channel).toBe('stable')
      expect(state.stableVersion).toBe('v1.19.30')
      expect(state.specificVersion).toBeNull()
      expect(state.effectiveVersion).toBe('v1.19.30')
      await rm(base, { recursive: true, force: true })
    })

    it('reflects a disabled kernel', async () => {
      const { service, settings, base } = await makeService()
      await settings.set({ kernelEnabled: false })
      const state = await service.getState()
      expect(state.enabled).toBe(false)
      await rm(base, { recursive: true, force: true })
    })
  })

  describe('setEnabled / setChannel', () => {
    it('persists the enable toggle through the settings gateway', async () => {
      const { service, settings, base } = await makeService()
      const state = await service.setEnabled(false)
      expect(state.enabled).toBe(false)
      expect(settings.settings.kernelEnabled).toBe(false)
      await rm(base, { recursive: true, force: true })
    })

    it('persists the channel and reflects a selected specific version', async () => {
      const { service, settings, base } = await makeService()
      await settings.set({ kernelSpecificVersion: 'v1.19.20' })
      const state = await service.setChannel('specific')
      expect(state.channel).toBe('specific')
      expect(state.specificVersion).toBe('v1.19.20')
      expect(state.effectiveVersion).toBe('v1.19.20')
      expect(settings.settings.kernelChannel).toBe('specific')
      await rm(base, { recursive: true, force: true })
    })
  })

  describe('listVersions', () => {
    it('loads the published versions and clears loading', async () => {
      const { service, base } = await makeService({
        versions: ['v1.19.30', 'v1.19.20', 'v1.19.11']
      })
      const state = await service.listVersions()
      expect(state.versions).toEqual(['v1.19.30', 'v1.19.20', 'v1.19.11'])
      expect(state.versionsLoading).toBe(false)
      await rm(base, { recursive: true, force: true })
    })

    it('surfaces an error without throwing', async () => {
      const { service, base } = await makeService()
      const bad = new KernelManagerService({
        workspaceRoot: join(base, 'kernel'),
        platform: 'win32',
        arch: 'amd64',
        settings: new FakeAppSettingsGateway(),
        fetchVersions: async () => {
          throw new Error('network down')
        }
      })
      const state = await bad.listVersions()
      expect(state.error).toContain('network down')
      expect(state.versionsLoading).toBe(false)
      await rm(base, { recursive: true, force: true })
    })
  })

  describe('install', () => {
    it('downloads, verifies, resolves and selects the version', async () => {
      const { service, settings, base } = await makeService()
      let resolveCalledWith: string | null = null
      const spy = new KernelManagerService({
        workspaceRoot: join(base, 'kernel'),
        platform: 'win32',
        arch: 'amd64',
        settings,
        fetchVersions: async () => ['v1.19.30', 'v1.19.20'],
        fetchReleaseAssets: async (version) => [
          {
            name: `mihomo-windows-amd64-${version}.zip`,
            digest: `sha256:${'a'.repeat(64)}`,
            size: 1000,
            browser_download_url: `https://example.com/${version}.zip`
          }
        ],
        resolveAsset: async (asset, workspaceDir) => {
          resolveCalledWith = workspaceDir
          return {
            path: join(workspaceDir, 'mihomo.exe'),
            version: asset.version?.replace(/^v/, '') ?? '1.19.30',
            asset,
            sha256: asset.sha256,
            url: asset.url,
            reused: false
          }
        }
      })
      const state = await spy.install('v1.19.20')
      expect(state.channel).toBe('specific')
      expect(state.specificVersion).toBe('v1.19.20')
      expect(state.effectiveVersion).toBe('v1.19.20')
      expect(state.error).toBeNull()
      expect(state.installing).toBeNull()
      expect(settings.settings.kernelSpecificVersion).toBe('v1.19.20')
      expect(resolveCalledWith).toBe(join(base, 'kernel', 'versions', '1.19.20'))
      await rm(base, { recursive: true, force: true })
    })

    it('rejects an invalid version without touching the settings', async () => {
      const { service, settings, base } = await makeService()
      const state = await service.install('not-a-version')
      expect(state.error).toContain('无效的版本号')
      expect(settings.settings.kernelSpecificVersion).toBe('')
      expect(settings.settings.kernelChannel).toBe('stable')
      await rm(base, { recursive: true, force: true })
    })

    it('surfaces a download/verify failure as state.error, not a throw', async () => {
      const { base } = await makeService()
      const settings = new FakeAppSettingsGateway()
      const spy = new KernelManagerService({
        workspaceRoot: join(base, 'kernel'),
        platform: 'win32',
        arch: 'amd64',
        settings,
        fetchReleaseAssets: async (version) => [
          {
            name: `mihomo-windows-amd64-${version}.zip`,
            digest: `sha256:${'a'.repeat(64)}`,
            size: 1000,
            browser_download_url: `https://example.com/${version}.zip`
          }
        ],
        resolveAsset: async () => {
          throw new Error('digest mismatch')
        }
      })
      const state = await spy.install('v1.19.20')
      expect(state.error).toContain('digest mismatch')
      expect(settings.settings.kernelChannel).toBe('stable')
      await rm(base, { recursive: true, force: true })
    })

    it('caches the asset spec and reuses it on a later ensureVersionBinary', async () => {
      const { base } = await makeService()
      const settings = new FakeAppSettingsGateway()
      let fetchCount = 0
      const spy = new KernelManagerService({
        workspaceRoot: join(base, 'kernel'),
        platform: 'win32',
        arch: 'amd64',
        settings,
        fetchReleaseAssets: async (version) => {
          fetchCount += 1
          return [
            {
              name: `mihomo-windows-amd64-${version}.zip`,
              digest: `sha256:${'a'.repeat(64)}`,
              size: 1000,
              browser_download_url: `https://example.com/${version}.zip`
            }
          ]
        },
        resolveAsset: async (asset, workspaceDir) => ({
          path: join(workspaceDir, 'mihomo.exe'),
          version: asset.version?.replace(/^v/, '') ?? '1.19.30',
          asset,
          sha256: asset.sha256,
          url: asset.url,
          reused: true
        })
      })
      await spy.install('v1.19.20')
      expect(fetchCount).toBe(1)
      await spy.ensureVersionBinary('v1.19.20')
      expect(fetchCount).toBe(1) // sidecar cached; no second fetch

      const versionDir = join(base, 'kernel', 'versions', '1.19.20')
      const files = await readdir(versionDir)
      expect(files).toContain('.mihomo-asset.json')
      const spec = JSON.parse(await readFile(join(versionDir, '.mihomo-asset.json'), 'utf8'))
      expect(spec.version).toBe('v1.19.20')
      expect(spec.sha256).toBe('a'.repeat(64))
      await rm(base, { recursive: true, force: true })
    })
  })

  describe('resolver callbacks', () => {
    it('isEnabled reflects the settings gate', async () => {
      const { service, settings, base } = await makeService()
      expect(await service.isEnabled()).toBe(true)
      await settings.set({ kernelEnabled: false })
      expect(await service.isEnabled()).toBe(false)
      await rm(base, { recursive: true, force: true })
    })

    it('getVersionSelection returns the current selection', async () => {
      const { service, settings, base } = await makeService()
      expect(await service.getVersionSelection()).toEqual({ channel: 'stable', specificVersion: null })
      await settings.set({ kernelChannel: 'specific', kernelSpecificVersion: 'v1.19.20' })
      expect(await service.getVersionSelection()).toEqual({ channel: 'specific', specificVersion: 'v1.19.20' })
      await rm(base, { recursive: true, force: true })
    })
  })

  describe('live GitHub metadata requests', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('bounds the live GitHub API call with a timeout (no infinite busy latch)', async () => {
      // A hung api.github.com connection previously kept listVersions busy for
      // minutes: the fetch had no timeout, unlike every other network path in
      // the app (subscription fetch 30s, kernel archive download bounded). The
      // request now carries AbortSignal.timeout; a hanging stub proves the
      // service reports a typed timeout error instead of latching versionsLoading.
      vi.stubGlobal('fetch', vi.fn((_url: string | URL, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')))
        })
      ))
      const base = await mkdtemp(join(tmpdir(), 'kernel-manager-'))
      try {
        const service = new KernelManagerService({
          workspaceRoot: join(base, 'kernel'),
          platform: 'win32',
          arch: 'amd64',
          settings: new FakeAppSettingsGateway(),
          githubTimeoutMs: 50
          // No fetchVersions override: exercises the real githubRequest path.
        })
        const state = await service.listVersions()
        expect(state.versionsLoading).toBe(false)
        expect(state.error).toContain('超时')
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    })
  })
})
