/**
 * Static isolation checks for the G1 probe.
 *
 * The G1 probe must never be reachable from the app shell, the preload bridge or
 * the IPC layer, and the pure core must remain free of any OS/Wintun/network
 * call site. A default `npm test` must never be able to load a Wintun DLL, spawn
 * mihomo or touch routes/DNS/proxy/firewall. These checks enforce that by
 * scanning the source graph.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8')
}

/** The modules that must never be imported by the app shell / preload / IPC. */
const G1_MODULE_MARKERS = ['g1-probe', 'g1-driver', 'g1-probe-runner', 'wintun-abi', 'tun/']

describe('G1 probe isolation', () => {
  it('keeps the probe out of the app shell, preload bridge and IPC layer', () => {
    const appFiles = [
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/main/ipc/handlers.ts',
      'src/main/ipc/register-ipc.ts'
    ]
    for (const file of appFiles) {
      const source = read(file)
      for (const marker of G1_MODULE_MARKERS) {
        expect(source, `${file} must not reference ${marker}`).not.toContain(marker)
      }
    }
  })

  it('keeps the pure core free of node I/O, Wintun and network call sites', () => {
    const core = read('src/main/tun/g1-probe.ts')
    expect(core).not.toMatch(/from\s+['"]node:/)
    // Strip comments so doc references to the Wintun API don't count as call sites.
    const code = stripComments(core)
    expect(code).not.toMatch(
      /Wintun(?:Create|Open|Close)\s*\(|child_process|execFile|fetch\s*\(|WebSocket|netsh|SetIpForwardEntry|SetInterfaceDnsSettings|new WebSocket/
    )
  })

  it('does not wire the standalone runner into any module in src', () => {
    // The runner is a standalone `--execute-g1-probe` entry; nothing in src may import it.
    const imports = findImports('src', "g1-probe-runner")
    expect(imports).toEqual([])
  })

  it('does not import the real driver anywhere except the runner dynamic import', () => {
    // The real driver is only ever referenced by the runner via a lazy import(),
    // never by a static `from '...'` specifier in src.
    const imports = findImports('src', "g1-driver")
    expect(imports).toEqual([])
  })

  it('holds the real driver to the gated seam contract', () => {
    const driver = read('src/main/tun/g1-driver.ts')
    // The seam legitimately references the Wintun ABI and child_process, so the
    // contract here is that those live ONLY in the driver, and the module is not
    // in the app graph (checked above).
    expect(driver).toMatch(/child_process/)
    expect(driver).toMatch(/Wintun(?:Create|Open|Close)/)
    // But it must never invoke the forbidden 0.14.1 delete paths (comments may
    // name them, so we require a call site: a name immediately followed by '(').
    expect(driver).not.toMatch(/WintunDeleteAdapter\s*\(|WintunDeleteDriver\s*\(/)
  })
})

/** Recursively find static import specifiers matching a module basename. */
function findImports(dir: string, basename: string): string[] {
  const matches: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!full.endsWith('.ts')) continue
      const source = readFileSync(full, 'utf8')
      if (new RegExp(`from\\s+['"][^'"]*${basename}['"]`).test(source)) {
        matches.push(full)
      }
    }
  }
  walk(resolve(root, dir))
  return matches
}

/** Remove line and block comments so call-site scans ignore doc references. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
