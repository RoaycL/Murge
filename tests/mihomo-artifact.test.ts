import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  MIHOMO_VERSION,
  MIHOMO_RELEASE_BASE,
  mihomoAssetFor,
  mihomoAssetCatalog,
  mihomoBinaryName,
  mihomoVersionNoV,
  downloadAndVerifyMihomo,
  extractMihomo,
  resolveMihomo,
  sha256File,
  type MihomoAsset,
  type MihomoVerifiedMarker
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
    size: bytes.length,
    kind: 'zip',
    innerName: 'mihomo-windows-amd64.exe',
    ...overrides
  }
}

const requestFromBuffer =
  (bytes: Buffer) =>
  async (_url: string): Promise<Readable> => Readable.from(bytes)

function markerFor(dir: string, asset: MihomoAsset, binary: string, overrides: Partial<MihomoVerifiedMarker> = {}): MihomoVerifiedMarker {
  return {
    version: mihomoVersionNoV(),
    archiveSha256: asset.sha256,
    binarySha256: '',
    platform: asset.platform,
    arch: asset.arch,
    binary,
    ...overrides
  }
}

const stubFetch = (response: Response) => {
  const stub = vi.fn(async () => response)
  vi.stubGlobal('fetch', stub)
  return stub
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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
    expect(asset?.size).toBeGreaterThan(0)
  })

  it('exposes the verified windows arm64 asset (official zip + inner exe)', () => {
    const asset = mihomoAssetFor('win32', 'arm64')
    expect(asset).not.toBeNull()
    expect(asset?.filename).toBe('mihomo-windows-arm64-v1.19.30.zip')
    expect(asset?.kind).toBe('zip')
    expect(asset?.innerName).toBe('mihomo-windows-arm64.exe')
    expect(asset?.url).toBe(`${MIHOMO_RELEASE_BASE}/mihomo-windows-arm64-v1.19.30.zip`)
    expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(asset?.size).toBeGreaterThan(0)
  })

  it('exposes the verified linux arm64 asset', () => {
    const asset = mihomoAssetFor('linux', 'arm64')
    expect(asset).not.toBeNull()
    expect(asset?.kind).toBe('gz')
    expect(asset?.innerName).toBe('mihomo-linux-arm64')
    expect(asset?.url).toBe(`${MIHOMO_RELEASE_BASE}/mihomo-linux-arm64-v1.19.30.gz`)
    expect(asset?.size).toBeGreaterThan(0)
  })

  it('returns null for an unsupported platform/arch', () => {
    expect(mihomoAssetFor('linux', 's390x')).toBeNull()
    expect(mihomoAssetFor('freebsd', 'x64')).toBeNull()
  })

  it('catalog entries are internally consistent (url/version/sha/size/inner)', () => {
    for (const asset of mihomoAssetCatalog()) {
      expect(asset.url).toBe(`${MIHOMO_RELEASE_BASE}/${asset.filename}`)
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.filename).toContain(MIHOMO_VERSION)
      expect(typeof asset.size).toBe('number')
      expect(asset.size).toBeGreaterThan(0)
      expect(asset.innerName.length).toBeGreaterThan(0)
    }
  })

  it('maps the target executable basename per platform', () => {
    expect(mihomoBinaryName('win32')).toBe('mihomo.exe')
    expect(mihomoBinaryName('linux')).toBe('mihomo')
  })

  it('strips the leading v from the version', () => {
    expect(mihomoVersionNoV()).toBe('1.19.30')
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
    expect(await readdir(dir)).toEqual([])
  })

  it('rejects when the stream truncates early (fewer bytes than pinned)', async () => {
    const dir = await wi()
    const asset = fakeAsset(Buffer.from('the full pinned 100-byte archive payload'))
    // A truncated prefix has a different digest and byte count, so it must fail.
    const truncated = Buffer.from('the full pinned 100-byte arch')
    await expect(
      downloadAndVerifyMihomo(asset, { destDir: dir, request: requestFromBuffer(truncated) })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_HASH_MISMATCH })
    expect(await readdir(dir)).toEqual([])
  })

  it('aborts and removes the partial file when the stream exceeds the byte cap', async () => {
    const dir = await wi()
    const asset = fakeAsset(Buffer.from('small archive'), { size: 11 })
    const oversized = Readable.from(Buffer.alloc(256 * 1024, 0x61))
    await expect(
      downloadAndVerifyMihomo(asset, {
        destDir: dir,
        request: async () => oversized
      })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED })
    expect(await readdir(dir)).toEqual([])
  })

  it('destroys a hung upload stream past the timeout', async () => {
    const dir = await wi()
    const asset = fakeAsset(Buffer.from('x'))
    // A stream that never ends: `_read` pushes nothing and never completes.
    const neverEnding = new Readable({
      read() {
        /* never push, never end */
      }
    })
    await expect(
      downloadAndVerifyMihomo(asset, {
        destDir: dir,
        timeoutMs: 40,
        request: async () => neverEnding
      })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED })
  })

  it('rejects an oversized content-length without streaming', async () => {
    const dir = await wi()
    const asset = fakeAsset(Buffer.from('x'), { size: 1 })
    stubFetch(
      new Response('x', { headers: { 'content-length': String(999_999_999) } })
    )
    await expect(
      downloadAndVerifyMihomo(asset, { destDir: dir })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED })
    expect(await readdir(dir)).toEqual([])
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
  it('renames the inner binary to the stable target name', async () => {
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
  })

  it('makes the extracted binary executable on non-Windows', async () => {
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
    const st = await stat(target)
    expect(st.isFile()).toBe(true)
    expect(st.mode & 0o111).toBeTruthy()
  })

  it('keeps the Windows target name mihomo.exe', async () => {
    const dir = await wi()
    const asset = fakeAsset(Buffer.from('payload'), { platform: 'win32', arch: 'x64', kind: 'zip', innerName: 'mihomo-windows-amd64.exe' })
    const extractArchive = async (_asset: MihomoAsset, _archive: string, destDir: string) => {
      await writeFile(join(destDir, _asset.innerName), 'PE')
    }
    const target = await extractMihomo(asset, {
      destDir: dir,
      archivePath: join(dir, 'archive'),
      extractArchive
    })
    expect(target).toBe(join(dir, 'mihomo.exe'))
    expect(await readFile(target, 'utf8')).toBe('PE')
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
    expect(asset.url.startsWith(MIHOMO_RELEASE_BASE)).toBe(true)
    // No verified marker or binary may survive a failed verification.
    expect(await readdir(dir)).toEqual([])
  })

  it('reuses an already-verified binary without re-downloading', async () => {
    const dir = await wi()
    const asset = mihomoAssetFor('win32', 'x64')!
    const binary = join(dir, 'mihomo.exe')
    await writeFile(binary, 'existing verified payload')
    const binarySha256 = await sha256File(binary)
    await writeFile(
      join(dir, '.mihomo-verified'),
      JSON.stringify(markerFor(dir, asset, 'mihomo.exe', { binarySha256 }))
    )
    const request = vi.fn()
    const extractArchive = vi.fn()

    const result = await resolveMihomo('win32', 'x64', {
      workspaceDir: dir,
      request: request as unknown as (url: string) => Promise<Readable>,
      extractArchive: extractArchive as unknown as typeof extractMihomo
    })
    expect(result.reused).toBe(true)
    expect(result.path).toBe(binary)
    expect(result.sha256).toBe(asset.sha256)
    expect(request).not.toHaveBeenCalled()
    expect(extractArchive).not.toHaveBeenCalled()
    expect(await readFile(result.path, 'utf8')).toBe('existing verified payload')
  })

  it('refuses to reuse a modified binary and re-verifies from a fresh download', async () => {
    const dir = await wi()
    const asset = mihomoAssetFor('win32', 'x64')!
    const binary = join(dir, 'mihomo.exe')
    // Seed a valid marker, then tamper with the on-disk binary so its hash no
    // longer matches the recorded binarySha256.
    await writeFile(binary, 'original verified payload')
    const binarySha256 = await sha256File(binary)
    await writeFile(
      join(dir, '.mihomo-verified'),
      JSON.stringify(markerFor(dir, asset, 'mihomo.exe', { binarySha256 }))
    )
    await writeFile(binary, 'tampered payload!!!')

    const request = async () => Readable.from(Buffer.from('not the pinned bytes'))
    await expect(
      resolveMihomo('win32', 'x64', { workspaceDir: dir, request })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_HASH_MISMATCH })
    // The tampered binary and its marker were quarantined before re-download.
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses to reuse a forged marker (wrong recorded binary hash)', async () => {
    const dir = await wi()
    const asset = mihomoAssetFor('win32', 'x64')!
    const binary = join(dir, 'mihomo.exe')
    await writeFile(binary, 'verified payload')
    await writeFile(
      join(dir, '.mihomo-verified'),
      JSON.stringify(markerFor(dir, asset, 'mihomo.exe', { binarySha256: 'f'.repeat(64) }))
    )
    const request = async () => Readable.from(Buffer.from('not the pinned bytes'))
    await expect(
      resolveMihomo('win32', 'x64', { workspaceDir: dir, request })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_HASH_MISMATCH })
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses to reuse a binary when the marker platform mismatches', async () => {
    const dir = await wi()
    const asset = mihomoAssetFor('win32', 'x64')!
    const binary = join(dir, 'mihomo.exe')
    await writeFile(binary, 'verified payload')
    const binarySha256 = await sha256File(binary)
    await writeFile(
      join(dir, '.mihomo-verified'),
      JSON.stringify(markerFor(dir, asset, 'mihomo.exe', { binarySha256, platform: 'linux' }))
    )
    const request = async () => Readable.from(Buffer.from('not the pinned bytes'))
    await expect(
      resolveMihomo('win32', 'x64', { workspaceDir: dir, request })
    ).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_HASH_MISMATCH })
    expect(await readdir(dir)).toEqual([])
  })

  it('throws UNSUPPORTED for an unverified platform/arch', async () => {
    const dir = await wi()
    await expect(
      resolveMihomo('freebsd', 'x64', { workspaceDir: dir })
    ).rejects.toBeInstanceOf(ProtocolError)
  })
})
