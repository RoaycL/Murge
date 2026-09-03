import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MihomoKernelResolver, mihomoExecutableName } from '../src/main/kernel/resolvers'
import { sha256File, type ResolvedMihomoBinary } from '../src/main/kernel/mihomo-artifact'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'

const fakeResolved: ResolvedMihomoBinary = {
  path: '/ws/mihomo.exe',
  version: '1.19.30',
  asset: {
    platform: 'win32',
    arch: 'x64',
    filename: 'mihomo-windows-amd64-v1.19.30.zip',
    url: 'https://example.invalid/asset.zip',
    sha256: 'a'.repeat(64),
    size: 1,
    kind: 'zip',
    innerName: 'mihomo-windows-amd64.exe'
  },
  sha256: 'a'.repeat(64),
  url: 'https://example.invalid/asset.zip',
  reused: false
}

const wi = () => mkdtemp(join(tmpdir(), 'mihomo-resolver-'))

describe('MihomoKernelResolver', () => {
  it('refuses to resolve a real binary when not explicitly enabled', async () => {
    const resolver = new MihomoKernelResolver({ allowReal: false, workspaceDir: '/ws' })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.UNSUPPORTED })
  })

  it('refuses a binaryPath without expectedSha256 (unverifiable)', async () => {
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      binaryPath: '/opt/tools/mihomo.exe'
    })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.UNSUPPORTED })
  })

  it('resolves a verified binaryPath after hashing the file', async () => {
    const dir = await wi()
    const binPath = join(dir, 'mihomo.exe')
    await writeFile(binPath, 'verified bytes')
    const expected = await sha256File(binPath)
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      binaryPath: binPath,
      expectedSha256: expected,
      version: '1.19.30',
      platform: 'win32',
      arch: 'x64'
    })
    const binary = await resolver.resolve()
    expect(binary.command).toBe(binPath)
    expect(binary.args).toEqual([])
    expect(binary.version).toBe('1.19.30')
    expect(binary.env).toMatchObject({ MIHOMO_PLATFORM: 'win32', MIHOMO_ARCH: 'x64' })
  })

  it('rejects a binaryPath whose bytes do not match expectedSha256', async () => {
    const dir = await wi()
    const binPath = join(dir, 'mihomo.exe')
    await writeFile(binPath, 'different bytes')
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      binaryPath: binPath,
      expectedSha256: 'f'.repeat(64)
    })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.ARTIFACT_HASH_MISMATCH })
  })

  it('rejects a relative binaryPath', async () => {
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      binaryPath: 'relative/mihomo.exe',
      expectedSha256: 'a'.repeat(64)
    })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
  })

  it('rejects a binaryPath that is a symlink', async (ctx) => {
    const dir = await wi()
    const target = join(dir, 'real.exe')
    const link = join(dir, 'link.exe')
    await writeFile(target, 'bytes')
    try {
      await symlink(target, link, 'file')
    } catch (error) {
      // Creating a FILE symlink on Windows requires admin or Developer Mode, and
      // unlike a directory link there is no unprivileged equivalent (a junction
      // only links directories). Skip rather than fail on an ordinary developer
      // machine; the guard itself is `lstat().isSymbolicLink()` in resolvers.ts,
      // which is platform-independent, and this case still runs on the Ubuntu CI
      // verification job and on any host where the link can be created.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip()
        return
      }
      throw error
    }
    const expected = await sha256File(target)
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      binaryPath: link,
      expectedSha256: expected
    })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
  })

  it('rejects a binaryPath that does not exist', async () => {
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      binaryPath: '/does/not/exist.exe',
      expectedSha256: 'a'.repeat(64)
    })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
  })

  it('maps a resolved mihomo binary onto a KernelBinary (download path)', async () => {
    const resolveMihomoOverride = vi.fn(
      async (_platform: string, _arch: string): Promise<ResolvedMihomoBinary> => fakeResolved
    )
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      platform: 'win32',
      arch: 'x64',
      resolveMihomoOverride
    })
    const binary = await resolver.resolve()
    expect(binary.command).toBe('/ws/mihomo.exe')
    expect(binary.version).toBe('1.19.30')
    expect(binary.env).toMatchObject({ MIHOMO_PLATFORM: 'win32', MIHOMO_ARCH: 'x64' })
    expect(resolveMihomoOverride).toHaveBeenCalledWith('win32', 'x64', { workspaceDir: '/ws' })
  })

  it('propagates an unsupported platform from the resolver', async () => {
    const resolveMihomoOverride = vi.fn(async () => {
      throw new ProtocolError(ProtocolErrorCode.UNSUPPORTED, 'No pinned mihomo artifact')
    })
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      platform: 'freebsd',
      arch: 'x64',
      resolveMihomoOverride
    })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.UNSUPPORTED })
  })

  it('fails clearly when the installer-bundled archive is missing', async () => {
    const dir = await wi()
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: join(dir, 'workspace'),
      bundledArchiveDir: join(dir, 'empty-bin'),
      platform: 'win32',
      arch: 'x64'
    })
    await expect(resolver.resolve()).rejects.toMatchObject({
      code: ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED,
      message: expect.stringContaining('Bundled mihomo archive is missing')
    })
  })

  it('refuses to resolve when the kernel is disabled via the manager gate', async () => {
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      platform: 'win32',
      arch: 'x64',
      kernelEnabled: async () => false
    })
    await expect(resolver.resolve()).rejects.toMatchObject({
      code: ProtocolErrorCode.UNSUPPORTED,
      message: expect.stringContaining('内核已停用')
    })
  })

  it('resolves a stable channel through the normal pinned path', async () => {
    const resolveMihomoOverride = vi.fn(
      async (_platform: string, _arch: string): Promise<ResolvedMihomoBinary> => fakeResolved
    )
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      platform: 'win32',
      arch: 'x64',
      kernelEnabled: async () => true,
      versionSelection: async () => ({ channel: 'stable', specificVersion: null }),
      resolveMihomoOverride
    })
    const binary = await resolver.resolve()
    expect(binary.command).toBe('/ws/mihomo.exe')
    expect(resolveMihomoOverride).toHaveBeenCalled()
  })

  it('resolves a specific version through ensureSpecificBinary', async () => {
    const ensureSpecificBinary = vi.fn(
      async (version: string): Promise<ResolvedMihomoBinary> => ({
        ...fakeResolved,
        path: `/ws/versions/${version}/mihomo.exe`,
        version
      })
    )
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      platform: 'win32',
      arch: 'x64',
      kernelEnabled: async () => true,
      versionSelection: async () => ({ channel: 'specific', specificVersion: 'v1.19.20' }),
      ensureSpecificBinary
    })
    const binary = await resolver.resolve()
    expect(ensureSpecificBinary).toHaveBeenCalledWith('v1.19.20')
    expect(binary.command).toBe('/ws/versions/v1.19.20/mihomo.exe')
    expect(binary.version).toBe('v1.19.20')
    expect(binary.env).toMatchObject({ MIHOMO_PLATFORM: 'win32', MIHOMO_ARCH: 'x64' })
  })
})

describe('mihomoExecutableName', () => {
  it('returns the platform-specific basename', () => {
    expect(mihomoExecutableName('win32')).toBe('mihomo.exe')
    expect(mihomoExecutableName('linux')).toBe('mihomo')
  })
})
