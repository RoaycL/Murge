import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brand } from '@shared/brand'

// Read the builder config as a module so the assertions track what is actually
// resolved at packaging time rather than duplicating the mapping as literals.
const config = (await import('../electron-builder.config.mjs')).default

describe('electron-builder brand wiring (Phase 6 metadata)', () => {
  it('uses the appId, productName and executableName from brand', () => {
    expect(config.appId).toBe(brand.appId)
    expect(config.productName).toBe(brand.productName)
    expect(config.executableName).toBe(brand.executableName)
  })

  it('wires the protocol scheme from brand (product name + scheme)', () => {
    expect(config.protocols).toHaveLength(1)
    expect(config.protocols[0].name).toBe(brand.productName)
    expect(config.protocols[0].schemes).toContain(brand.protocolScheme)
  })

  it('sets Windows CompanyName from brand.companyName via author metadata', () => {
    expect(config.extraMetadata.author.name).toBe(brand.companyName)
  })

  it('sets the Windows LegalCopyright from brand.copyright', () => {
    expect(config.copyright).toBe(brand.copyright)
  })

  it('configures a Windows icon that exists in build resources', () => {
    expect(config.win.icon).toBeTruthy()
    // buildResources is `resources`, so a bare `icon.ico` resolves to it.
    const resourcesDir = fileURLToPath(new URL('../resources/', import.meta.url))
    expect(() => readFileSync(join(resourcesDir, config.win.icon))).not.toThrow()
  })

  it('preserves user data (profiles) on uninstall by default', () => {
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false)
  })

  it('bundles the third-party notices into the installer', () => {
    const notices = config.extraResources.find((r) => r.from.includes('THIRD_PARTY_NOTICES'))
    expect(notices).toBeTruthy()
    expect(() =>
      readFileSync(join(fileURLToPath(new URL('../resources/', import.meta.url)), 'THIRD_PARTY_NOTICES.md'))
    ).not.toThrow()
  })

  it('bundles the retained dependency license texts into the installer', () => {
    const licenses = config.extraResources.find((r) => r.from.includes('licenses'))
    expect(licenses).toBeTruthy()
    const resourcesDir = fileURLToPath(new URL('../resources/', import.meta.url))
    for (const file of ['vue.txt', 'ws.txt', 'electron.txt']) {
      expect(() => readFileSync(join(resourcesDir, 'licenses', file))).not.toThrow()
    }
  })

  it('bundles only the current installer architecture mihomo archive', () => {
    expect(config.extraResources).toContainEqual({
      from: 'resources/bin/${arch}',
      to: 'bin',
      filter: ['*.zip']
    })
  })

  it('bundles the matching privileged service and requires a per-machine installer', () => {
    expect(config.extraResources).toContainEqual({
      from: 'resources/tun-service/${arch}',
      to: 'tun-service',
      filter: ['tun-service.exe', 'service-template.json']
    })
    expect(config.nsis.perMachine).toBe(true)
    expect(config.nsis.allowElevation).toBe(true)
  })

  it('produces exactly two per-arch NSIS installers (strategy A, no combined)', () => {
    // Strategy A: x64 + arm64 only, never the combined/universal installer.
    expect(config.nsis.buildUniversalInstaller).toBe(false)
    expect(config.win.target).toHaveLength(1)
    expect(config.win.target[0].target).toBe('nsis')
    expect(config.win.target[0].arch).toEqual(['x64', 'arm64'])
    // The artifact name is arch-suffixed so each install file is distinguishable.
    expect(config.win.artifactName).toContain('${arch}')
  })

  it('bundles the GPL text without configuring an installer clickthrough page', () => {
    expect(config.extraResources).toContainEqual({ from: 'LICENSE', to: 'LICENSE.txt' })
    expect(config.nsis.license).toBeUndefined()
  })
})
