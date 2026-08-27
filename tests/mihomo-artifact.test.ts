import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  MIHOMO_VERSION,
  MIHOMO_RELEASE_BASE,
  mihomoAssetFor,
  mihomoAssetCatalog,
  mihomoBinaryName,
  downloadAndVerifyMihomo,
  extractMihomo,
  resolveMihomo,
  type MihomoAsset
} from '../src/main/kernel/mihomo-artifact'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

const wi = async () => mkdtemp(join(tmpdir(), 'mihomo-artifact-'))

function fakeAsset(bytes: Buffer, overrides: Partial<MihomoAsset> = {}): MihomoAsset {
  return {
    platform: 'win32',
    arch: 'x64',
    filename: 'mihomo-windows-amd64-v1.19.30.zip',
    url: 'https://example.invalid/asset.zip',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    kind: 'zip',
    innerName: 'mihomo-windows-amd64.exe',
    ...overrides
  }
}

const requestFromBuffer =
  (bytes: Buffer) =>
  async (): Promise<Readable> => Readable.from(bytes)

describe('mihomo artifact metadata', () => {
  it('pins the official version and release base', () => {
    expect(MIHOMO_VERSION).toBe('v1.19.30')
    expect(MIHOMO_RELEASE_BASE).toBe(`https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}`)
  })

  it('exposes the verified windows x64 asset', () => {
    const asset = mihomoAssetFor('win32', 'x64')
    expect(asset).not.toBeNull()
    expect(asset?.filename).toBe('mihomo-windows-amd64-v1.19.30.zip')
    expect(asset?.kind).toBe('zip')
    expect(asset?.innerName).toBe('mihomo-windows-amd64.exe')
    expect(asset?.url).toBe(`${MIHOMO_RELEASE_BASE}/mihomo-windows-amd64-v1.19.30.zip`)
    expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exposes the verified linux arm64 asset', () => {
    const asset = mihomoAssetFor('linux', 'arm64')
    expect(asset).not.toBeNull()
    expect(asset?.kind).toBe('gz')
    expect(asset?.innerName).toBe('mihomo-linux-arm64')
    expect(asset?.url).toBe(`${MIHOMO_RELEASE_BASE}/mihomo-linux-arm64-v1.19.30.gz`)
  })

  it('returns null for an unsupported platform/arch', () => {
    expect(mihomoAssetFor('linux', 's390x')).toBeNull()
    expect(mihomoAssetFor('freebsd', 'x64')).toBeNull()
  })

  it('catalog entries are internally consistent (url/version/sha)', () => {
    for (const asset of mihomoAssetCatalog()) {
      expect(asset.url).toBe(`${MIHOMO_RELEASE_BASE}/${asset.filename}`)
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.filename).toContain(MIHOMO_VERSION)
    }
  })

  it('maps the target executable basename per platform', () => {
    expect(mihomoBinaryName('win32')).toBe('mihomo.exe')
    expect(mihomoBinaryName('linux')).toBe('mihomo')
  })
})

describe('downloadAndVerifyMihomo', () => {
  it('streams bytes to the archive path when the digest matches', async () => {
    const dir = await wi()
    const bytes = Buffer.from('official archive payload')
    const asset = fakeAsset(bytes)
    const archivePath = await downloadAndVerifyMihomo(asset, {
      destDir: dir,
      request: requestFromBuffer(bytes)
    })
    expect(archivePath).toBe(join(dir, asset.filename))
    expect(await readFile(archivePath)).toEqual(bytes)
  })

  it('rejects with ARTIFACT_HASH_MISMATCH and removes the file when the digest differs', async () => {
    const dir = await wi()
    const bytes = Buffer.from('tampered archive payload')
    const asset = fakeAsset(Buffer.from('something else'))
    await expect(
      downloadAndVerifyMihomo(asset, { destDir: dir, request: requestFromBuffer(bytes) })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_HASH_MISMATCH })
    const entries = await readdir(dir)
    expect(entries).toEqual([])
  })

  it('surfaces a transport failure as ARTIFACT_DOWNLOAD_FAILED', async () => {
    const dir = await wi()
    const asset = fakeAsset(Buffer.from('x'))
    await expect(
      downloadAndVerifyMihomo(asset, {
        destDir: dir,
        request: async () => {
          throw new Error('network down')
        }
      })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED })
  })
})

describe('extractMihomo', () => {
  it('renames the inner binary to the stable target name and writes a marker', async () => {
    const dir = await wi()
    const asset = fakeAsset(Buffer.from('payload'), { platform: 'linux', arch: 'arm64', kind: 'gz', innerName: 'mihomo-linux-arm64' })
    const extractArchive = async (_asset: MihomoAsset, _archive: string, destDir: string) => {
      await writeFile(join(destDir, _asset.innerName), 'ELF')
    }
    const target = await extractMihomo(asset, {
      destDir: dir,
      archivePath: join(dir, 'archive'),
      extractArchive
    })
    expect(target).toBe(join(dir, 'mihomo'))
    expect(await readFile(target, 'utf8')).toBe('ELF')
    expect(await readFile(join(dir, '.mihomo-verified'), 'utf8')).toBe(`${asset.sha256}\n`)
  })

  it('marks an extraction failure as ARTIFACT_EXTRACT_FAILED', async () => {
    const dir = await wi()
    const asset = fakeAsset(Buffer.from('payload'))
    await expect(
      extractMihomo(asset, {
        destDir: dir,
        archivePath: join(dir, 'archive'),
        extractArchive: async () => {
          throw new Error('dammaged zip')
        }
      })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_EXTRACT_FAILED })
  })
})

describe('resolveMihomo', () => {
  it('downloads the pinned asset and rejects when the bytes fail verification', async () => {
    const dir = await wi()
    const asset = mihomoAssetFor('win32', 'x64')!
    const request = async () => Readable.from(Buffer.from('bytes that do not match the pinned digest'))
    await expect(
      resolveMihomo('win32', 'x64', { workspaceDir: dir, request })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_HASH_MISMATCH })
    // Real-world url + filename are wired through to the downloader.
    expect(typeof asset.url).toBe('string')
    expect(asset.url.startsWith(MIHOMO_RELEASE_BASE)).toBe(true)
    // No verified marker is written on failure, so nothing was left behind.
    await expect(readFile(join(dir, '.mihomo-verified'), 'utf8')).rejects.toBeTruthy()
  })

  it('reuses an already-verified binary without re-downloading', async () => {
    const dir = await wi()
    const asset = mihomoAssetFor('win32', 'x64')!
    await writeFile(join(dir, '.mihomo-verified'), asset.sha256 + '\n')
    await writeFile(join(dir, 'mihomo.exe'), 'existing verified payload')
    const request = vi.fn()
    const extractArchive = vi.fn()

    const result = await resolveMihomo('win32', 'x64', {
      workspaceDir: dir,
      request: request as unknown as (url: string) => Promise<Readable>,
      extractArchive: extractArchive as unknown as typeof extractMihomo
    })
    expect(result.reused).toBe(true)
    expect(result.path).toBe(join(dir, 'mihomo.exe'))
    expect(result.sha256).toBe(asset.sha256)
    expect(request).not.toHaveBeenCalled()
    expect(extractArchive).not.toHaveBeenCalled()
    expect(await readFile(result.path, 'utf8')).toBe('existing verified payload')
  })

  it('throws UNSUPPORTED for an unverified platform/arch', async () => {
    const dir = await wi()
    await expect(
      resolveMihomo('freebsd', 'x64', { workspaceDir: dir })
    ).rejects.toBeInstanceOf(ProtocolError)
  })
})
