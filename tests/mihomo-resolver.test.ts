import { describe, it, expect, vi } from 'vitest'
import { MihomoKernelResolver, mihomoExecutableName } from '../src/main/kernel/resolvers'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import type { ResolvedMihomoBinary } from '../src/main/kernel/mihomo-artifact'

const fakeResolved: ResolvedMihomoBinary = {
  path: '/ws/mihomo.exe',
  version: '1.19.30',
  asset: {
    platform: 'win32',
    arch: 'x64',
    filename: 'mihomo-windows-amd64-v1.19.30.zip',
    url: 'https://example.invalid/asset.zip',
    sha256: 'a'.repeat(64),
    kind: 'zip',
    innerName: 'mihomo-windows-amd64.exe'
  },
  sha256: 'a'.repeat(64),
  url: 'https://example.invalid/asset.zip',
  reused: false
}

describe('MihomoKernelResolver', () => {
  it('refuses to resolve a real binary when not explicitly enabled', async () => {
    const resolver = new MihomoKernelResolver({ allowReal: false, workspaceDir: '/ws' })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.UNSUPPORTED })
  })

  it('returns a pre-resolved binary path when binaryPath is supplied', async () => {
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      binaryPath: '/opt/tools/mihomo.exe',
      version: '1.19.30'
    })
    const binary = await resolver.resolve()
    expect(binary.command).toBe('/opt/tools/mihomo.exe')
    expect(binary.args).toEqual([])
    expect(binary.version).toBe('1.19.30')
  })

  it('maps a resolved mihomo binary onto a KernelBinary (download path)', async () => {
    const resolveMihomo = vi.fn(async (_platform: string, _arch: string): Promise<ResolvedMihomoBinary> => fakeResolved)
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      platform: 'win32',
      arch: 'x64',
      resolveMihomo
    })
    const binary = await resolver.resolve()
    expect(binary.command).toBe('/ws/mihomo.exe')
    expect(binary.version).toBe('1.19.30')
    expect(binary.env).toMatchObject({ MIHOMO_PLATFORM: 'win32', MIHOMO_ARCH: 'x64' })
    expect(resolveMihomo).toHaveBeenCalledWith('win32', 'x64', { workspaceDir: '/ws' })
  })

  it('propagates an unsupported platform from the resolver', async () => {
    const resolveMihomo = vi.fn(async () => {
      throw new ProtocolError(ProtocolErrorCode.UNSUPPORTED, 'No pinned mihomo artifact')
    })
    const resolver = new MihomoKernelResolver({
      allowReal: true,
      workspaceDir: '/ws',
      platform: 'freebsd',
      arch: 'x64',
      resolveMihomo
    })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: ProtocolErrorCode.UNSUPPORTED })
  })
})

describe('mihomoExecutableName', () => {
  it('returns the platform-specific basename', () => {
    expect(mihomoExecutableName('win32')).toBe('mihomo.exe')
    expect(mihomoExecutableName('linux')).toBe('mihomo')
  })
})
