import { beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('Windows packaging and interactive GUI CI contracts', () => {
  let hostedWorkflow: string
  let interactiveWorkflow: string
  let interactiveScript: string
  let mainEntry: string

  beforeAll(async () => {
    ;[hostedWorkflow, interactiveWorkflow, interactiveScript, mainEntry] = await Promise.all([
      readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
      readFile(path.join(root, '.github/workflows/windows-gui-smoke.yml'), 'utf8'),
      readFile(path.join(root, 'scripts/windows-interactive-gui-smoke.ps1'), 'utf8'),
      readFile(path.join(root, 'src/main/index.ts'), 'utf8')
    ])
  })

  it('keeps the hosted package job static and explicitly non-interactive', () => {
    expect(hostedWorkflow).toContain('Install, verify & uninstall Windows NSIS (x64, hosted-safe)')
    expect(hostedWorkflow).toContain("$interactiveDesktop = $false")
    expect(hostedWorkflow).toContain("'out/main/index.js'")
    expect(hostedWorkflow).toContain("'out/preload/index.js'")
    expect(hostedWorkflow).toContain("'out/renderer/index.html'")
    expect(hostedWorkflow).not.toContain('MURGE_CI_SKIP_ELECTRON_RESTORE')
    expect(hostedWorkflow).toContain("-ArgumentList '--uninstall' -Label 'installed TUN service removal'")
  })

  it('runs packaged Electron probes only on an explicitly interactive self-hosted runner', () => {
    expect(interactiveWorkflow).toContain('workflow_dispatch:')
    expect(interactiveWorkflow).toMatch(/runs-on: \[self-hosted, Windows, X64, interactive-desktop\]/)
    expect(interactiveWorkflow).toContain('windows-interactive-gui-smoke.ps1')
    expect(interactiveScript).toContain("@('--packaging-smoke')")
    expect(interactiveScript).toContain("@('--kernel-smoke')")
    expect(interactiveScript).toContain("@('--ui-smoke')")
    expect(interactiveScript).toContain("@('--hidden', '--hidden-smoke')")
    expect(interactiveScript).toContain('MainWindowHandle')
  })

  it('does not leak an unconditional boot marker or user argv', () => {
    expect(mainEntry).not.toContain('murge-boot-marker.json')
    expect(mainEntry).toContain("process.env.MURGE_CI_BOOT_DIAG === '1'")
  })

  it('allows the interactive clean-launch probe to suppress kernel autostart only in Actions', () => {
    expect(mainEntry).toContain("process.env.GITHUB_ACTIONS === 'true' && hasArg('--no-kernel-autostart')")
    expect(mainEntry).toContain('!is.dev && !skipKernelAutostart')
    expect(mainEntry).not.toContain('!launchHidden && !skipKernelAutostart')
    expect(interactiveScript).toContain("@('--no-kernel-autostart')")
  })

  it('starts bounded cleanup from the Windows session-end lifecycle', () => {
    expect(mainEntry).toContain("window.on('session-end'")
    expect(mainEntry).toContain('beginApplicationShutdown(true)')
    expect(mainEntry).toContain("powerMonitor.on('shutdown'")
  })
})
