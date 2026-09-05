import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probeDir = join(repoRoot, 'tests', 'electron-redirect-runtime')

/**
 * Real-runtime guard for the kernel-proxy subscription transport.
 *
 * Unit tests exercise the fetcher with fake transports, which cannot see the
 * Electron-specific failure this transport exists to avoid: on Electron 38,
 * net.fetch with redirect:'manual' rejects every redirect with
 * "Redirect was cancelled" (electron/electron#43715), and auto-following
 * redirects is the pattern CVE-2026-70605 turned into a local-file exposure.
 * This spec boots the actual Electron binary, loads the compiled transport
 * plus the compiled SubscriptionFetcher in the main process, and asserts the
 * hop-interception contract against a local HTTP server: synthetic 3xx hops,
 * zero unvalidated follow-through, per-hop private-address rejection (exact
 * error code + message + zero requests reaching the internal target) and the
 * redirect budget after exactly maxRedirects+1 requests. The probe is fully
 * offline — .test hostnames are split across Chromium's connection resolver
 * (--host-resolver-rules) and the fetcher's injected resolveHost — so no leg
 * depends on internet reachability.
 *
 * Skipped when the electron binary is unavailable or (on Linux) no display is
 * present; CI runs it explicitly on Windows, locally under xvfb-run.
 */

let electronBinary: string | null = null
try {
  // The electron package resolves to the binary path string under plain Node.
  const candidate = require('electron') as unknown
  if (typeof candidate === 'string' && existsSync(candidate)) electronBinary = candidate
} catch {
  electronBinary = null
}

const missingDisplay =
  process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY

const shouldRun = Boolean(electronBinary) && !missingDisplay

const tempDir = shouldRun ? mkdtempSync(join(tmpdir(), 'murge-electron-probe-')) : null

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

describe.skipIf(!shouldRun)('electron redirect runtime', () => {
  it(
    'intercepts redirect hops in a real Electron main process',
    { timeout: 120000 },
    () => {
      // Bundle the transport and the fetcher as standalone CJS so the probe
      // can require them without electron-vite's app bundle. esbuild ships
      // with vite; resolve it from the repo root.
      const esbuild = require(resolve(repoRoot, 'node_modules', 'esbuild')) as {
        buildSync: (options: Record<string, unknown>) => unknown
      }
      for (const entry of ['proxy-fetch-transport', 'subscription-fetcher']) {
        esbuild.buildSync({
          entryPoints: [join(repoRoot, 'src', 'main', 'subscriptions', `${entry}.ts`)],
          outfile: join(tempDir!, `${entry}.cjs`),
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external: ['electron'],
          logLevel: 'silent'
        })
      }

      let stdout = ''
      try {
        stdout = execFileSync(
          electronBinary!,
          [
            '--no-sandbox',
            // Route the RFC-2606 .test probe hosts to the probe's local HTTP
            // server at the connection layer (Chromium), while the fetcher's
            // injected resolveHost controls the validation layer's view.
            '--host-resolver-rules=MAP public-label.test 127.0.0.1,MAP private-label.test 127.0.0.1',
            probeDir
          ],
          {
            env: { ...process.env, PROBE_BUNDLE_DIR: tempDir! },
            encoding: 'utf8',
            timeout: 110000
          }
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A headless Linux CI without the GUI library set cannot boot
        // Electron; skip rather than fail where the probe cannot run.
        if (/Missing X server|cannot open display|error while loading shared libraries/i.test(message)) {
          return
        }
        throw new Error(`electron probe failed:\n${stdout}\n${message}`)
      }

      expect(stdout).toContain('PROBE-Begin')
      const verdicts = stdout.split('\n').filter((line) => /: (PASS|FAIL|SKIP)/.test(line))
      // A1 A2 B1 B2 B3 A3 — see tests/electron-redirect-runtime/probe.cjs.
      // Every leg is local (the probe is fully offline), so all six must run
      // and pass; a network hiccup cannot skip or fail any of them.
      expect(verdicts).toHaveLength(6)
      for (const verdict of verdicts) expect(verdict).toContain('PASS')
      for (const verdict of verdicts) expect(verdict).not.toContain('FAIL')
      // The regression this suite guards: a manual-mode redirect must surface
      // as a synthetic 302, never as Electron's "Redirect was cancelled".
      expect(stdout).not.toContain('Redirect was cancelled')
    }
  )
})
