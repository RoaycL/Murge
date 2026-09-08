import { describe, expect, it } from 'vitest'
import {
  parseBootFlags,
  shouldDisableHardwareAcceleration,
  writeBootDiagnostics
} from '../src/main/electron/boot-flags'
import { createDeepLinkQueue, extractDeepLink } from '../src/main/electron/deep-link'
import { brand } from '../src/shared/brand'

/**
 * Phase 1 shell-boundary units: the CI boot-flag parser, the deep-link queue
 * and the window geometry moved out of the former monolithic entry into
 * Electron-free modules. These lock the Phase 1 extraction semantics.
 */
describe('parseBootFlags', () => {
  it('accepts flags from argv and the MURGE_CI_BOOT_FLAGS forwarder', () => {
    const flags = parseBootFlags(['murge', '--hidden'], { MURGE_CI_BOOT_FLAGS: ' --packaging-smoke   --ui-smoke ' })
    expect(flags.ciBootFlags).toEqual(['--packaging-smoke', '--ui-smoke'])
    expect(flags.hasArg('--hidden')).toBe(true)
    expect(flags.hasArg('--packaging-smoke')).toBe(true)
    expect(flags.hasArg('--ui-smoke')).toBe(true)
    expect(flags.hasArg('--missing')).toBe(false)
  })

  it('detects the login-item silent launch only from --hidden', () => {
    expect(parseBootFlags(['murge', '--hidden'], {}).launchHidden).toBe(true)
    expect(parseBootFlags(['murge'], {}).launchHidden).toBe(false)
    // The CI forwarder counts too (a wrapper may deliver the login launch).
    expect(parseBootFlags(['murge'], { MURGE_CI_BOOT_FLAGS: '--hidden' }).launchHidden).toBe(true)
  })

  it('suppresses kernel autostart only when GITHUB_ACTIONS is true AND the flag is present', () => {
    expect(
      parseBootFlags(['murge', '--no-kernel-autostart'], { GITHUB_ACTIONS: 'true' }).skipKernelAutostart
    ).toBe(true)
    expect(
      parseBootFlags(['murge', '--no-kernel-autostart'], { GITHUB_ACTIONS: 'false' }).skipKernelAutostart
    ).toBe(false)
    expect(
      parseBootFlags(['murge', '--no-kernel-autostart'], {}).skipKernelAutostart
    ).toBe(false)
    // The flag must come from argv or the forwarder, not just exist somewhere.
    expect(parseBootFlags(['murge'], { GITHUB_ACTIONS: 'true' }).skipKernelAutostart).toBe(false)
  })

  it('keeps diagnostics opt-in and never throws on an unwritable path', () => {
    expect(() => writeBootDiagnostics(['murge'], parseBootFlags(['murge'], {}), '/cwd', {})).not.toThrow()
    // Unset env + unwritable path must both be no-ops (diagnostics never break the app).
    expect(() =>
      writeBootDiagnostics(['murge'], parseBootFlags(['murge'], {}), '/cwd', {
        MURGE_CI_BOOT_DIAG: '1',
        MURGE_CI_BOOT_DIAG_PATH: '/definitely/not/writable/dir/file.json'
      })
    ).not.toThrow()
  })
})

describe('shouldDisableHardwareAcceleration', () => {
  it('matches every headless probe flag and nothing else', () => {
    const probes = [
      '--packaging-smoke',
      '--kernel-smoke',
      '--ui-smoke',
      '--hidden-smoke',
      '--system-proxy-enable',
      '--restore-system-proxy'
    ]
    for (const probe of probes) {
      expect(shouldDisableHardwareAcceleration((flag) => flag === probe), probe).toBe(true)
    }
    expect(shouldDisableHardwareAcceleration(() => false)).toBe(false)
  })
})

describe('deep-link queue (murge:// registration plumbing)', () => {
  it('extracts the branded scheme link from a launch argv', () => {
    const link = `${brand.protocolScheme}://import/sub?id=7`
    expect(extractDeepLink([link])).toBe(link)
    expect(extractDeepLink(['murge', '--hidden', link])).toBe(link)
    expect(extractDeepLink(['murge', '--hidden'])).toBeNull()
  })

  it('queues links that arrive before the window exists and never loses one', () => {
    const queue = createDeepLinkQueue()
    expect(queue.pending).toEqual([])
    expect(queue.pushFromArgv(['other-app', `${brand.protocolScheme}://a`])).toBe(`${brand.protocolScheme}://a`)
    queue.pushFromArgv([`${brand.protocolScheme}://b`])
    queue.pushFromArgv(['no-link-here'])
    expect(queue.pending).toEqual([`${brand.protocolScheme}://a`, `${brand.protocolScheme}://b`])
  })
})

describe('window geometry', () => {
  it('keeps the approved 934x672 reference viewport with the 848x640 fluid minimum', async () => {
    // The adapter imports Electron, so assert on the source literal here and
    // let activity-ui-contract pin the regex shape.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/main/electron/window-adapter.ts', import.meta.url), 'utf8')
    expect(source).toContain('width: 934,')
    expect(source).toContain('height: 672,')
    expect(source).toContain('useContentSize: true,')
    expect(source).toContain('minWidth: 848,')
    expect(source).toContain('minHeight: 640')
  })
})
