import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    const resourcesDir = new URL('../resources/', import.meta.url).pathname
    expect(() => readFileSync(join(resourcesDir, config.win.icon))).not.toThrow()
  })

  it('preserves user data (profiles) on uninstall by default', () => {
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false)
  })

  it('bundles the third-party notices into the installer', () => {
    const notices = config.extraResources.find((r) => r.from.includes('THIRD_PARTY_NOTICES'))
    expect(notices).toBeTruthy()
    expect(() =>
      readFileSync(join(new URL('../resources/', import.meta.url).pathname, 'THIRD_PARTY_NOTICES.md'))
    ).not.toThrow()
  })

  it('bundles the retained dependency license texts into the installer', () => {
    const licenses = config.extraResources.find((r) => r.from.includes('licenses'))
    expect(licenses).toBeTruthy()
    const resourcesDir = new URL('../resources/', import.meta.url).pathname
    for (const file of ['vue.txt', 'ws.txt', 'electron.txt']) {
      expect(() => readFileSync(join(resourcesDir, 'licenses', file))).not.toThrow()
    }
  })

  it('builds exactly two per-arch NSIS targets (strategy A, no combined installer)', () => {
    expect(config.win.target).toHaveLength(2)
    config.win.target.forEach((t) => expect(t.target).toBe('nsis'))
    expect(config.win.target.map((t) => t.arch[0]).sort()).toEqual(['arm64', 'x64'])
    // The artifact name is arch-suffixed so each install file is distinguishable.
    expect(config.win.artifactName).toContain('${arch}')
  })

  it('does NOT configure a license page (app license is pending owner decision)', () => {
    expect(config.nsis.license).toBeUndefined()
  })
})
