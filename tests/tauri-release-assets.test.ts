import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM script without type declarations
import { installerName, selectInstallers } from '../scripts/tauri-release-assets.mjs'

const workflow = readFileSync(new URL('../.github/workflows/tauri-release.yml', import.meta.url), 'utf8')

describe('Tauri release assets', () => {
  it('uses the bundler NSIS name the updater manifest expects', () => {
    expect(installerName('App', '1.2.3', 'x64')).toBe('App_1.2.3_x64-setup.exe')
    expect(installerName('App', '1.2.3', 'arm64')).toBe('App_1.2.3_arm64-setup.exe')
  })

  it('requires exactly one installer per architecture', () => {
    const both = ['App_1.2.3_x64-setup.exe', 'App_1.2.3_arm64-setup.exe', 'notes.md']
    expect(selectInstallers(both, 'App', '1.2.3')).toEqual({ x64: both[0], arm64: both[1] })
    expect(() => selectInstallers([both[0]], 'App', '1.2.3')).toThrow(/missing installer App_1.2.3_arm64/)
    expect(() => selectInstallers(both, 'App', '1.2.4')).toThrow(/missing installer/)
    expect(() => selectInstallers([...both, 'App_1.2.2_x64-setup.exe'], 'App', '1.2.3')).toThrow(/unexpected installers/)
  })

  it('publishes Tauri builds only as non-latest pre-releases from tauri-v tags', () => {
    expect(workflow).toMatch(/tags:\s*\n\s*- 'tauri-v\*'/)
    expect(workflow).toContain('--prerelease --latest=false')
    // The signing key is only handed to the publish job, never to the Windows builds.
    const build = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  publish:'))
    expect(build).not.toContain('TAURI_SIGNING_PRIVATE_KEY')
  })
})
