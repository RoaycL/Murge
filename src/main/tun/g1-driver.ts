/**
 * Real G1 probe driver — binds the pinned Wintun ABI and drives the isolated
 * mihomo probe. It is the technology seam behind `g1-probe.ts`; the pure
 * orchestrator never imports it.
 *
 * **Execution policy (deliverable A/B).** The native Wintun binding is
 * intentionally NOT bundled here (see `WintunNativeBinding`): a genuine native
 * FFI surface is a separate, owner-approved integration that is only ever
 * supplied on the gated `murge-tun-lab` self-hosted Windows runner, behind the
 * protected `phase9-tun-lab` environment, with every gate satisfied. Until then
 * `binding` is null and every Wintun/mihomo primitive fails closed to
 * `unsupported`, so no DLL is loaded, no mihomo is spawned and the OS is never
 * mutated. The read-only network snapshot + diff (routes/DNS/proxy/firewall)
 * is implemented standalone and is inert unless invoked.
 *
 * This module is never imported from `src/main/index.ts`, `src/preload` or the
 * IPC handlers, so the app bundle never contains it. A static isolation test
 * enforces that.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { G1ErrorCode } from './g1-probe'
import type {
  G1AdapterIdentity,
  G1NetworkSnapshot,
  G1ProbeDriver,
  G1ProbeIdentityTarget,
  G1ReuseResult
} from './g1-probe'
import { WINTUN_DLL_NAME, WINTUN_PINNED_VERSION } from './wintun-abi'

/** A resolved native Wintun function symbol (an opaque FFI callable). */
export type WintunResolvedSymbol = (...args: unknown[]) => unknown

/**
 * Abstract native binding seam. Supplied by a future owner-approved native
 * integration (e.g. a koffi/ffi wrapper). Never bundled into the repo so the
 * default install/build stays green; the G1 gate remains unproven until a
 * binding is present.
 */
export interface WintunNativeBinding {
  /** Map our ABI name (e.g. 'WintunCreateAdapter') to a callable. */
  resolve(name: string): WintunResolvedSymbol | null
  /** Load the pinned DLL (only ever called after a successful digest check). */
  load(dllPath: string): void
  /** Our ABI names ALL must resolve; called once after load. */
  assertSymbols(symbols: readonly string[]): void
  /** Guidance from the OS for diagnostics. */
  lastError(): string
}

/** The pinned per-arch Wintun manifest (digest is the integrity root). */
export interface G1WintunManifest {
  version: string
  /** Canonical URL/source for the third-party notice. */
  source: string
  /** Per-arch SHA-256 of the bundled wintun DLL. */
  digests: Partial<Record<string, string>>
}

/**
 * The pinned manifest. The per-arch digest MUST be filled in from the official
 * Wintun release before any execution; an empty digest means the probe fails
 * closed (it refuses to load an unverified DLL). This is intentionally
 * unpopulated in the non-executed scaffold.
 */
export const PINNED_WINTUN_MANIFEST: G1WintunManifest = {
  version: WINTUN_PINNED_VERSION,
  source: 'https://www.wintun.net/ (official release; see resources/THIRD_PARTY_NOTICES.md)',
  digests: {}
}

/** Expects the digest to be 64 lower/upper-case hex characters (SHA-256). */
const SHA256_HEX = /^[0-9a-f]{64}$/i

/** Convert a canonical GUID string to the 16 little-endian bytes Wintun expects. */
export function guidToLittleEndianBytes(guid: string): number[] {
  const hex = guid.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 32) throw new Error('invalid GUID string')
  // GUID layout in memory is Data1..Data4 in little-endian for the first three
  // fields and a byte array for the last — matches the canonical string order.
  const bytes: number[] = []
  for (let i = 0; i < 32; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return [
    bytes[3], bytes[2], bytes[1], bytes[0], // Data1 (LE DWORD)
    bytes[5], bytes[4], // Data2 (LE WORD)
    bytes[7], bytes[6], // Data3 (LE WORD)
    bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15] // Data4 (bytes)
  ]
}

/**
 * Build the isolated mihomo config the probe uses to reuse the helper's adapter.
 * It is deliberately route/DNS/proxy-neutral: `auto-route` and `strict-route`
 * are false and no DNS server or in-band proxy is configured, so the probe can
 * never mutate the host's default routes, DNS or system proxy — only observe the
 * data plane. The probe never creates a second adapter (no dual ownership).
 */
export function buildIsolatedMihomoConfig(identity: G1AdapterIdentity & { mihomoPort: number }): string {
  const config = {
    tun: {
      enable: true,
      device: identity.name,
      auto_route: false,
      strict_route: false,
      stack: 'system'
    },
    dns: { enable: false },
    'inbound': { port: identity.mihomoPort, listen: '127.0.0.1' },
    'log-level': 'silent'
  }
  return JSON.stringify(config, null, 2)
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Read-only, side-effect-free host network snapshot + diff, used to prove the
 * probe never mutated routes / DNS / system proxy / firewall. Mirrors the
 * snapshot the real-kernel integration test uses. Windows-aware; on non-Windows
 * it returns a stable placeholder so the diff is deterministic (the probe only
 * ever runs on Windows anyway).
 */
export async function captureNetworkSnapshot(): Promise<G1NetworkSnapshot> {
  if (process.platform !== 'win32') {
    return {
      winhttpProxy: 'N/A (non-Windows)',
      internetSettingsProxy: 'N/A (non-Windows)',
      ipv4DefaultRoute: 'N/A (non-Windows)',
      ipv6DefaultRoute: 'N/A (non-Windows)',
      dnsServers: 'N/A (non-Windows)',
      activeAdapters: 'N/A (non-Windows)',
      firewallProfiles: 'N/A (non-Windows)'
    }
  }
  const netsh = (args: string[]): Promise<string> => runCapture('netsh', args)
  const ps = (script: string): Promise<string> =>
    runCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  const [winhttp, ipv4Route, ipv6Route, dns, adapters, firewall, ieProxy] = await Promise.all([
    netsh(['winhttp', 'show', 'proxy']),
    ps(`Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object NextHop,InterfaceAlias | ConvertTo-Json -Compress`),
    ps(`Get-NetRoute -DestinationPrefix '::/0' | Select-Object NextHop,InterfaceAlias | ConvertTo-Json -Compress`),
    ps(`Get-DnsClientServerAddress | Where-Object { $_.ServerAddresses } | Select-Object InterfaceAlias,ServerAddresses | ConvertTo-Json -Compress`),
    ps(`Get-NetAdapter | Select-Object Name,Status | ConvertTo-Json -Compress`),
    ps(`Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Compress`),
    ps(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride | ConvertTo-Json -Compress`)
  ])
  return { winhttpProxy: winhttp, internetSettingsProxy: ieProxy, ipv4DefaultRoute: ipv4Route, ipv6DefaultRoute: ipv6Route, dnsServers: dns, activeAdapters: adapters, firewallProfiles: firewall }
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve) => {
    try {
      const child = spawn(command, args, { shell: false })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('error', (e) => resolve(`UNAVAILABLE:${e.message}`))
      child.on('close', () => resolve(`${out}\n${err}`.trim()))
    } catch (e) {
      resolve(`UNAVAILABLE:${(e as Error).message}`)
    }
  })
}

/** Compare two snapshots; returns every field that changed. */
export function networkDiff(before: G1NetworkSnapshot, after: G1NetworkSnapshot): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const key of keys) {
    const a = before[key] ?? 'MISSING'
    const b = after[key] ?? 'MISSING'
    if (a !== b) changed.push(key)
  }
  return changed
}

export interface RealG1ProbeDriverOptions {
  /** Native binding; null = fail closed. */
  binding?: WintunNativeBinding | null
  /** Pinned manifest; unverified → fail closed. */
  manifest?: G1WintunManifest | null
  /** Directory containing the pinned per-arch wintun.dll. */
  wintunDir?: string
  /** Process architecture tag (defaults to the detected one). */
  architecture?: string
  pid?: number
}

/**
 * Construct the real driver. Fails closed to `unsupported` for every Wintun /
 * mihomo primitive whenever no native binding is supplied (the non-executed
 * state). The network snapshot + diff are always available.
 */
export function createRealG1ProbeDriver(
  opts: RealG1ProbeDriverOptions = {}
): G1ProbeDriver {
  const binding = opts.binding ?? null
  const manifest = opts.manifest ?? PINNED_WINTUN_MANIFEST
  const wintunDir = opts.wintunDir ?? process.env.MURGE_WINTUN_DIR ?? ''
  const architecture = opts.architecture ?? detectArchitecture()
  const pid = opts.pid ?? process.pid

  let resolved = false
  let lastDigest = ''
  let creatorOpen = false
  let createdIdentity: G1AdapterIdentity | null = null

  const dllPath = (): string => (wintunDir ? join(wintunDir, `${architecture}-${WINTUN_DLL_NAME}`) : '')

  const bound = (name: string): WintunResolvedSymbol => {
    if (!binding) throw new Error(G1ErrorCode.unsupported)
    const sym = binding.resolve(name)
    if (!sym) throw new Error(`${G1ErrorCode.unsupported}: unresolved native symbol ${name}`)
    return sym
  }

  return {
    architecture,
    pid,

    async loadPinnedWintun(): Promise<{ verified: boolean; digest: string }> {
      // No pinned digest for this arch, or no configured DLL path: fail closed to
      // "not verified" WITHOUT touching the loader or the OS (deliverable B).
      const digest = manifest.digests[architecture]
      if (!digest || !SHA256_HEX.test(digest)) return { verified: false, digest: '' }
      const path = dllPath()
      if (!path) return { verified: false, digest: '' }
      const computed = await sha256File(path)
      lastDigest = computed
      if (computed.toLowerCase() !== digest.toLowerCase()) {
        return { verified: false, digest: computed }
      }
      // Only a verified DLL may be loaded — and only when a native binding exists.
      if (!binding) throw new Error(`${G1ErrorCode.unsupported}: native binding not present`)
      binding.load(path)
      binding.assertSymbols([
        'WintunCreateAdapter',
        'WintunGetAdapterLUID',
        'WintunCloseAdapter',
        'WintunStartSession',
        'WintunEndSession',
        'WintunOpenAdapter'
      ])
      resolved = true
      return { verified: true, digest: computed }
    },

    async createAdapter(target: G1ProbeIdentityTarget & { tunnelType: string }): Promise<void> {
      const sym = bound('WintunCreateAdapter')
      const guidBytes = guidToLittleEndianBytes(target.requestedGuid)
      const handle = sym(target.name, target.tunnelType, guidBytes)
      if (!handle) {
        throw new Error(`${G1ErrorCode.unsupported}: WintunCreateAdapter returned NULL`)
      }
      creatorOpen = true
      createdIdentity = {
        name: target.name,
        requestedGuid: target.requestedGuid,
        canonicalLuid: '' // filled by readAdapterIdentity via the native LUID read
      }
    },

    async readAdapterIdentity(): Promise<G1AdapterIdentity> {
      if (!creatorOpen || !createdIdentity) {
        throw new Error(`${G1ErrorCode.unsupported}: no creator handle held`)
      }
      // The real binding reads the NET_LUID from the still-open handle and
      // returns it as a canonical '0x...' string. Fails closed without it.
      void bound('WintunGetAdapterLUID')
      throw new Error(`${G1ErrorCode.unsupported}: adapter identity requires a native binding`)
    },

    async liveAdapterIdentity(): Promise<G1AdapterIdentity | null> {
      if (!creatorOpen || !createdIdentity) return null
      // The live adapter behind the still-open creator handle must still carry
      // the recorded Name + RequestedGUID + LUID. Requires a native LUID read.
      throw new Error(`${G1ErrorCode.unsupported}: live adapter identity requires a native binding`)
    },

    async startMihomoProbe(): Promise<number> {
      // The isolated mihomo reuses the helper's adapter by name (same GUID), with
      // route/DNS/proxy disabled. Never creates a second adapter (no dual ownership).
      if (!binding) throw new Error(`${G1ErrorCode.unsupported}: mihomo probe requires a native binding`)
      // Config produced here is written to a runner-temp dir by the caller; the
      // probe process is spawned only after the Wintun adapter exists.
      void buildIsolatedMihomoConfig
      throw new Error(`${G1ErrorCode.unsupported}: mihomo probe spawn is gated, not wired in this scaffold`)
    },

    async matchingAdapterCount(): Promise<number> {
      void bound('WintunOpenAdapter')
      throw new Error(`${G1ErrorCode.unsupported}: adapter enumeration requires a native binding`)
    },

    async pollMihomoReuse(): Promise<G1ReuseResult> {
      throw new Error(`${G1ErrorCode.unsupported}: reuse observation requires a native binding`)
    },

    async stopMihomoProbe(): Promise<void> {
      if (!resolved) throw new Error(`${G1ErrorCode.unsupported}: mihomo probe not started`)
    },

    async closeCreatorHandle(): Promise<void> {
      const sym = bound('WintunCloseAdapter') // the ONLY 0.14.1 removal op
      sym()
      creatorOpen = false
    },

    async adapterStillPresent(): Promise<boolean> {
      throw new Error(`${G1ErrorCode.unsupported}: adapter presence requires a native binding`)
    },

    async cleanup(identityMatch: boolean): Promise<void> {
      // Identity-guarded teardown: the orchestrator passes whether the strict
      // identity matched. The real driver only closes its own creator handle and
      // stops the isolated mihomo — never WintunDeleteAdapter, never WintunDeleteDriver.
      if (identityMatch && creatorOpen && binding) {
        const sym = bound('WintunCloseAdapter')
        sym()
        creatorOpen = false
      }
    },

    captureNetworkSnapshot,
    networkDiff
  }
}

/** Best-effort architecture tag used for evidence. */
function detectArchitecture(): string {
  const arch = process.arch
  if (arch === 'x64') return 'x64'
  if (arch === 'arm64') return 'arm64'
  return arch
}
