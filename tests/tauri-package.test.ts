import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleResources, configOverlay, parseArches, root } from '../scripts/tauri-package.mjs'

const brand = JSON.parse(await readFile(join(root, 'brand.config.json'), 'utf8'))
const tauriConfig = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const hooks = await readFile(join(root, 'src-tauri', 'nsis', 'hooks.nsh'), 'utf8')

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// RFC 4122 name-based UUID (SHA-1), as electron-builder derives APP_GUID.
function uuidV5(name: string, namespace: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

describe('tauri bundle config', () => {
  it('is a per-machine NSIS installer whose exe is the one the TUN service pins', () => {
    expect(tauriConfig.identifier).toBe(brand.appId)
    expect(tauriConfig.mainBinaryName).toBe(brand.executableName)
    expect(tauriConfig.bundle.targets).toEqual(['nsis'])
    expect(tauriConfig.bundle.windows.nsis.installMode).toBe('perMachine')
    expect(tauriConfig.bundle.windows.nsis.installerHooks).toBe('nsis/hooks.nsh')
    // Updater artifacts are signed explicitly in the release job, not here.
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(false)
  })

  it('installs tray icons where the packaged tray looks for them', () => {
    expect(tauriConfig.bundle.resources).toEqual({ '../resources/tray/*.png': 'resources/tray/' })
  })

  it('recognizes the Electron install by the GUID electron-builder derives from the appId', () => {
    const guid = uuidV5(brand.appId, '50e065bc-3134-11e6-9bab-38c9862bdaf3')
    expect(hooks).toContain(`!define MURGE_ELECTRON_GUID "${guid}"`)
  })

  it('defines every hook and starts with a UTF-8 BOM so makensis reads the Chinese messages', async () => {
    const raw = await readFile(join(root, 'src-tauri', 'nsis', 'hooks.nsh'))
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    for (const hook of ['PREINSTALL', 'POSTINSTALL', 'PREUNINSTALL']) {
      expect(hooks).toContain(`!macro NSIS_HOOK_${hook}`)
    }
    expect(hooks).toContain('tun-service.exe" --install')
    expect(hooks).toContain('tun-service.exe" --uninstall')
    expect(hooks).toContain('--restore-system-proxy')
  })

  it('accepts only the shipped arches', () => {
    expect(parseArches(['--all'])).toEqual(['x64', 'arm64'])
    expect(parseArches(['arm64'])).toEqual(['arm64'])
    expect(() => parseArches(['ia32'])).toThrow()
  })
})

describe('bundleResources', () => {
  let base: string
  const archive = 'archive-contents'
  const manifest = {
    geodata: [{ filename: 'geosite.dat' }, { filename: 'GeoLite2-ASN.mmdb', outputFilename: 'ASN.mmdb' }],
    assets: [{ platform: 'win32', arch: 'x64', filename: 'mihomo-x64.zip', sha256: sha256(archive), innerName: 'mihomo.exe' }]
  }

  async function put(path: string, content = 'x'): Promise<void> {
    await mkdir(join(base, path, '..'), { recursive: true })
    await writeFile(join(base, path), content)
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'tauri-package-test-'))
    await put('brand.config.json', JSON.stringify(brand))
    await put('LICENSE')
    await put('resources/bin/x64/mihomo-x64.zip', archive)
    await put('resources/tun-service/x64/tun-service.exe')
    await put('resources/tun-service/x64/service-template.json', JSON.stringify({
      archiveFilename: 'mihomo-x64.zip', archiveSha256: sha256(archive), clientExecutableName: brand.executableName
    }))
    await put('resources/startup/register-task.ps1')
    await put('resources/defaults/config.yaml')
    await put('resources/geodata/geosite.dat')
    await put('resources/geodata/ASN.mmdb')
    await put('resources/geodata/resolved-assets.json')
    await put('resources/geodata/.download-partial')
    await put('resources/THIRD_PARTY_NOTICES.md')
    await put('resources/SOURCE_CODE.resolved.md')
    await put('resources/mihomo-resolved.json', JSON.stringify(manifest))
    await put('resources/licenses/vue.txt')
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('maps every input into the Electron-compatible layout under resources/', () => {
    const targets = Object.values(bundleResources('x64', { base, manifest })).sort()
    expect(targets).toEqual([
      'resources/LICENSE.txt',
      'resources/SOURCE_CODE.md',
      'resources/THIRD_PARTY_NOTICES.md',
      'resources/bin/mihomo-x64.zip',
      'resources/defaults/config.yaml',
      'resources/geodata/ASN.mmdb',
      'resources/geodata/geosite.dat',
      'resources/geodata/resolved-assets.json',
      'resources/licenses/vue.txt',
      'resources/mihomo-resolved.json',
      'resources/startup/register-task.ps1',
      'resources/tun-service/service-template.json',
      'resources/tun-service/tun-service.exe'
    ])
    expect(configOverlay('x64', { base, manifest }).bundle.resources).toEqual(bundleResources('x64', { base, manifest }))
  })

  it('rejects an archive that does not match its pin', async () => {
    await put('resources/bin/x64/mihomo-x64.zip', 'tampered')
    expect(() => bundleResources('x64', { base, manifest })).toThrow(/pinned sha256/)
  })

  it('rejects a service template built for another kernel or client', async () => {
    await put('resources/tun-service/x64/service-template.json', JSON.stringify({
      archiveFilename: 'mihomo-old.zip', archiveSha256: sha256(archive), clientExecutableName: brand.executableName
    }))
    expect(() => bundleResources('x64', { base, manifest })).toThrow(/stale/)
    await put('resources/tun-service/x64/service-template.json', JSON.stringify({
      archiveFilename: 'mihomo-x64.zip', archiveSha256: sha256(archive), clientExecutableName: 'other'
    }))
    expect(() => bundleResources('x64', { base, manifest })).toThrow(/clientExecutableName/)
  })

  it('fails on missing service or geodata inputs instead of shipping a broken installer', async () => {
    await rm(join(base, 'resources/geodata/ASN.mmdb'))
    expect(() => bundleResources('x64', { base, manifest })).toThrow(/ASN\.mmdb/)
    await rm(join(base, 'resources/tun-service/x64/tun-service.exe'))
    expect(() => bundleResources('x64', { base, manifest })).toThrow(/tun-service:build/)
  })

  it('has no asset for an arch the manifest does not pin', () => {
    expect(() => bundleResources('arm64', { base, manifest })).toThrow(/arm64/)
  })
})
