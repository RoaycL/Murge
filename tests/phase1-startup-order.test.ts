import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Phase 1 startup-order lock (static): the when-ready orchestration module is
 * the executable specification of the startup sequence. These assertions pin
 * the relative order of the load-bearing steps — they are extracted verbatim
 * from the former monolithic entry and must not drift during the Tauri port.
 */
const whenReady = readFileSync(resolve(process.cwd(), 'src/main/electron/when-ready.ts'), 'utf8')

function ordered(...anchors: string[]): void {
  const positions = anchors.map((anchor) => {
    const index = whenReady.indexOf(anchor)
    expect(index, `anchor not found: ${anchor}`).toBeGreaterThan(-1)
    return index
  })
  const sorted = [...positions].sort((a, b) => a - b)
  expect(positions, `anchors out of order: ${anchors.join(' -> ')}`).toEqual(sorted)
}

describe('startup order (static contract)', () => {
  it('validates the brand before anything else and registers identity + deep links before services', () => {
    ordered(
      'parseBrandConfig(brand)',
      'windowAdapter.registerIdentity()',
      'windowAdapter.queueLaunchDeepLink(process.argv)',
      'await shell.storageWarmup'
    )
  })

  it('runs headless probes before the kernel graph is built', () => {
    ordered(
      "hasArg('--packaging-smoke')",
      "hasArg('--restore-system-proxy')",
      'new KernelSupervisor('
    )
  })

  it('keeps kernel-smoke and system-proxy-enable probes behind the kernel + gateway wiring', () => {
    ordered(
      'new KernelSupervisor(',
      "hasArg('--kernel-smoke')",
      "hasArg('--system-proxy-enable')"
    )
  })

  it('restores orphaned state in layers: proxy backup -> stale service core -> TUN transaction', () => {
    // Source-layout order (matches the original file): the privileged-kernel
    // reconcile is declared inside the kernel graph, the proxy backup restore
    // starts at the system-proxy service, the TUN reconcile after it, and the
    // recoverManagedState join sequences them proxy -> kernel -> TUN.
    ordered(
      'const privilegedReconcile',
      'systemProxyService.init()',
      'const tunReconcile',
      'const recoverManagedState = systemProxyInit'
    )
    // The join itself is the behavioral ordering contract.
    const join = whenReady.indexOf('const recoverManagedState')
    const chain = whenReady.slice(join, join + 200)
    expect(chain).toMatch(/systemProxyInit\s*\n?\s*\.then\(\(\) => privilegedReconcile\)\s*\n?\s*\.then\(\(\) => tunReconcile\)/)
  })

  it('registers IPC, creates the window and the tray in the original order', () => {
    ordered(
      'state.disposeIpc = registerIpc({',
      'windowAdapter.createWindow()',
      'createTrayAdapter({'
    )
  })

  it('arms recovery loops only after startup reconciliation and before the auto-update check', () => {
    ordered(
      "hasArg('--hidden-smoke')",
      'restoreRuntimeIntent(settings, runtimeIntentDeps)',
      'state.runtimeIntentRecovery.start()',
      'state.networkDetector.start()',
      'if (settings.autoCheckUpdate)'
    )
  })
})

describe('shell boundary (static contract)', () => {
  it('keeps the entry point thin: no service construction outside the electron modules', () => {
    const entry = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    expect(entry).toContain("bootstrapShell()")
    expect(entry).toContain('runWhenReady(shell)')
    // The entry must not grow service wiring back.
    for (const marker of ['new KernelSupervisor', 'registerIpc(', 'new BrowserWindow', 'createTrayAdapter']) {
      expect(entry, `entry must not contain ${marker}`).not.toContain(marker)
    }
  })

  it('never lets the webview-facing renderer contract mention the TUN probe internals', () => {
    // Same G1/Wintun isolation rule as the runtime contract, applied to the
    // whole new shell surface (runtime variant lives in g1-probe-isolation).
    const shellFiles = [
      'src/main/electron/runtime-state.ts',
      'src/main/electron/deep-link.ts'
    ]
    for (const file of shellFiles) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      for (const marker of ['g1-probe', 'g1-driver', 'g1-probe-runner', 'wintun-abi']) {
        expect(source, `${file} must not reference ${marker}`).not.toContain(marker)
      }
    }
  })
})
