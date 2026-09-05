import { expect, it } from 'vitest'
import { resolveMihomoRelease } from '../scripts/resolve-mihomo-release.mjs'

const baseline = { version: 'v1.0.0', assets: [{ platform: 'win32', arch: 'x64', innerName: 'mihomo-windows-amd64.exe', kind: 'zip' }] }
const asset = { name: 'mihomo-windows-amd64-v2.0.0.zip', digest: 'sha256:' + 'a'.repeat(64), size: 123,
  browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/v2.0.0/mihomo-windows-amd64-v2.0.0.zip' }
it('derives version, archive and digest from one upstream release', () => {
  const result = resolveMihomoRelease({ tag_name: 'v2.0.0', assets: [asset] }, baseline)
  expect(result.version).toBe('v2.0.0')
  expect(result.assets[0]).toMatchObject({ filename: asset.name, sha256: 'a'.repeat(64), size: 123, innerName: 'mihomo-windows-amd64.exe' })
  expect(baseline.version).toBe('v1.0.0')
})
it.each([{ digest: null }, { size: 0 }, { browser_download_url: 'https://example.com/core.zip' }, { name: 'wrong.zip' }])('rejects invalid metadata %j', (patch) => {
  expect(() => resolveMihomoRelease({ tag_name: 'v2.0.0', assets: [{ ...asset, ...patch }] }, baseline)).toThrow()
})
it('does not silently substitute a preview release', () => {
  expect(() => resolveMihomoRelease({ tag_name: 'v2.0.0', prerelease: true, assets: [asset] }, baseline)).toThrow()
})
