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
 * `unsupported` (`G1ProbeError`), so no DLL is loaded, no mihomo is spawned and
 * the OS is never mutated. The read-only network snapshot + diff
 * (routes/DNS/proxy/firewall) is implemented standalone and is inert unless
 * invoked.
 *
 * This module is never imported from `src/main/index.ts`, `src/preload` or the
 * IPC handlers, so the app bundle never contains it. A static isolation test
 * enforces that.
 *
 * ABI ownership (P1-3): the real handle is an opaque native pointer carried by
 * the binding. `createAdapter` stores that pointer in a `WeakMap` keyed by the
 * TS `G1OpaqueHandle`; `closeCreatorHandle` retrieves it and passes the SAME
 * pointer to `WintunCloseAdapter` that `WintunCreateAdapter` returned. TS never
 * re-derives the handle width, the `NET_LUID`, `GUID` or `WINAPI` convention.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { parseDocument, isMap, isScalar, isAlias, type Node, type Scalar } from 'yaml'
import {
  G1ProbeError,
  G1ErrorCode,
  G1_EMPTY_CONFLICT_REPORT,
  type G1AdapterIdentity,
  type G1ConflictReport,
  type G1NetworkSnapshot,
  type G1OpaqueHandle,
  type G1ProbeDriver,
  type G1ProbeIdentityTarget,
  type G1ReuseResult
} from './g1-probe'
import { WINTUN_DLL_NAME, WINTUN_PINNED_VERSION } from './wintun-abi'
import { createConfigValidator } from '../profiles/config-validator'

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

// ---------------------------------------------------------------------------
// Isolated mihomo probe config: generate -> validate -> parse-back assert
// (P1-4). The keys are the OFFICIAL mihomo kebab-case keys; the underscore
// variants (`auto_route`, `strict_route`) and a top-level `inbound` are invalid
// and are rejected by the strict validator before mihomo is ever started. This
// config is route/DNS/proxy-neutral and never creates a second adapter.
// ---------------------------------------------------------------------------

/** Allowed top-level keys in the isolated probe config (exact set). */
export const G1_MIHOMO_TOP_KEYS = ['allow-lan', 'mode', 'tun', 'dns'] as const
/** Allowed keys inside `tun` (exact set). */
export const G1_MIHOMO_TUN_KEYS = [
  'enable',
  'stack',
  'device',
  'auto-route',
  'auto-detect-interface',
  'strict-route'
] as const
/** Allowed keys inside `dns` (exact set). */
export const G1_MIHOMO_DNS_KEYS = ['enable'] as const

/** Render a YAML scalar that round-trips the exact value. */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return value
  return JSON.stringify(value)
}

/**
 * Build the isolated mihomo config that reuses the helper's adapter by name.
 * `device` names the adapter NIC only — it does NOT itself prove that mihomo
 * reuses the helper's Wintun instance; the live session + same-GUID/LUID
 * observation (step h) is what proves (or fails to prove) reuse, so G1 stays
 * UNPROVEN until that is observed on a gated runner.
 */
export function buildIsolatedMihomoConfig(identity: G1AdapterIdentity): string {
  return [
    'allow-lan: false',
    'mode: direct',
    'tun:',
    '  enable: true',
    '  stack: system',
    '  device: ' + yamlScalar(identity.name),
    '  auto-route: false',
    '  auto-detect-interface: false',
    '  strict-route: false',
    'dns:',
    '  enable: false',
    ''
  ].join('\n')
}

/** Validate the shape of a nested map against an exact key allowlist. */
function nestedMapErrors(
  section: string,
  valueNode: unknown,
  allowed: readonly string[],
  expect: (key: string, value: Node) => string[]
): string[] {
  const errors: string[] = []
  if (!isMap(valueNode)) {
    errors.push(`${section} must be a YAML mapping`)
    return errors
  }
  const seen = new Set<string>()
  for (const item of valueNode.items as Array<{ key: Node; value: Node | null }>) {
    const k = item.key
    const v = item.value
    if (v === null) {
      errors.push(`${section} entries must have a value`)
      continue
    }
    if (isAlias(k) || isAlias(v) || k.tag !== undefined || v.tag !== undefined) {
      errors.push(`${section} must not use aliases or tags`)
      continue
    }
    if (!isScalar(k) || typeof k.value !== 'string') {
      errors.push(`${section} keys must be plain scalar strings`)
      continue
    }
    const nestedKey = k.value
    if (seen.has(nestedKey)) {
      errors.push(`duplicate key in ${section}: ${nestedKey}`)
      continue
    }
    seen.add(nestedKey)
    if (!allowed.includes(nestedKey)) {
      errors.push(`unknown key in ${section}: ${nestedKey}`)
      continue
    }
    errors.push(...expect(nestedKey, v))
  }
  for (const key of allowed) {
    if (!seen.has(key)) errors.push(`missing required key in ${section}: ${key}`)
  }
  return errors
}

const isBoolFalse = (v: Node): v is Scalar => isScalar(v) && v.value === false
const isBoolTrue = (v: Node): v is Scalar => isScalar(v) && v.value === true
const isString = (v: Node): v is Scalar => isScalar(v) && typeof v.value === 'string'

function tunFieldErrors(key: string, v: Node, expectedDevice: string): string[] {
  if (key === 'enable') return isBoolTrue(v) ? [] : ['tun.enable must be true']
  if (key === 'stack') {
    return isString(v) && v.value === 'system' ? [] : ['tun.stack must be system']
  }
  if (key === 'device') {
    return isString(v) && v.value === expectedDevice ? [] : ['tun.device must match the probe adapter name']
  }
  // auto-route / auto-detect-interface / strict-route must be false.
  return isBoolFalse(v) ? [] : [`tun.${key} must be false`]
}

function dnsFieldErrors(key: string, v: Node): string[] {
  return isBoolFalse(v) ? [] : ['dns.enable must be false']
}

/**
 * Strict G1 probe-config validator. Returns every violation as a message. Any
 * unknown/duplicated/aliased/tagged key, any top-level key outside the exact
 * allowlist, or any security field that is not exactly its required value is
 * rejected — the underscore variants (`auto_route`, `strict_route`) and a
 * top-level `inbound` are unknown keys and therefore fail here.
 */
export function g1MihomoConfigErrors(text: string, expectedDevice: string): string[] {
  const errors: string[] = []
  const doc = parseDocument(text, { uniqueKeys: true })
  for (const err of doc.errors) errors.push(`YAML parse error: ${err.message.split('\n')[0]}`)
  if (!isMap(doc.contents)) {
    errors.push('probe config must be a YAML mapping at the top level')
    return errors
  }
  const seen = new Set<string>()
  for (const item of doc.contents.items as Array<{ key: Node; value: Node | null }>) {
    const k = item.key
    const v = item.value
    if (v === null) {
      errors.push('probe config entries must have a value')
      continue
    }
    if (isAlias(k) || isAlias(v) || k.tag !== undefined || v.tag !== undefined) {
      errors.push('probe config must not use aliases or tags')
      continue
    }
    if (!isScalar(k) || typeof k.value !== 'string') {
      errors.push('probe config keys must be plain scalar strings')
      continue
    }
    const key = k.value
    if (seen.has(key)) {
      errors.push(`duplicate key: ${key}`)
      continue
    }
    seen.add(key)
    if (!(G1_MIHOMO_TOP_KEYS as readonly string[]).includes(key)) {
      errors.push(`unknown top-level key: ${key}`)
      continue
    }
    if (key === 'allow-lan') {
      if (!isBoolFalse(v)) errors.push('allow-lan must be false')
    } else if (key === 'mode') {
      if (!(isString(v) && v.value === 'direct')) errors.push('mode must be direct')
    } else if (key === 'tun') {
      errors.push(...nestedMapErrors('tun', v, G1_MIHOMO_TUN_KEYS, (n, vv) => tunFieldErrors(n, vv, expectedDevice)))
    } else if (key === 'dns') {
      errors.push(...nestedMapErrors('dns', v, G1_MIHOMO_DNS_KEYS, dnsFieldErrors))
    }
  }
  for (const key of G1_MIHOMO_TOP_KEYS) {
    if (!seen.has(key)) errors.push(`missing required top-level key: ${key}`)
  }
  return errors
}

/** The parsed-back security field values asserted by the validator. */
export interface G1MihomoParsedSecurityFields {
  allowLan: boolean
  mode: string
  tunEnable: boolean
  tunStack: string
  tunDevice: string
  autoRoute: boolean
  autoDetectInterface: boolean
  strictRoute: boolean
  dnsEnable: boolean
}

/** Parse a validated probe config back into its security field values. */
export function parseBackG1MihomoConfig(text: string): G1MihomoParsedSecurityFields {
  const doc = parseDocument(text)
  const root = doc.contents
  if (!isMap(root)) throw new G1ProbeError(G1ErrorCode.internal, 'probe config parse-back: not a mapping')
  const getScalar = (map: Node, key: string): Node | null => {
    if (!isMap(map)) return null
    for (const item of map.items as Array<{ key: Node; value: Node | null }>) {
      if (isScalar(item.key) && item.key.value === key && item.value !== null) return item.value
    }
    return null
  }
  const asBool = (n: Node | null): boolean => {
    if (!isScalar(n)) return false
    return typeof n.value === 'boolean' ? (n.value as boolean) : false
  }
  const asString = (n: Node | null): string => {
    if (!isScalar(n) || typeof n.value !== 'string') return ''
    return n.value as string
  }
  return {
    allowLan: asBool(getScalar(root as Node, 'allow-lan')),
    mode: asString(getScalar(root as Node, 'mode')),
    tunEnable: asBool(getScalar(getScalar(root as Node, 'tun') as Node, 'enable')),
    tunStack: asString(getScalar(getScalar(root as Node, 'tun') as Node, 'stack')),
    tunDevice: asString(getScalar(getScalar(root as Node, 'tun') as Node, 'device')),
    autoRoute: asBool(getScalar(getScalar(root as Node, 'tun') as Node, 'auto-route')),
    autoDetectInterface: asBool(getScalar(getScalar(root as Node, 'tun') as Node, 'auto-detect-interface')),
    strictRoute: asBool(getScalar(getScalar(root as Node, 'tun') as Node, 'strict-route')),
    dnsEnable: asBool(getScalar(getScalar(root as Node, 'dns') as Node, 'enable'))
  }
}

/**
 * Generate -> validate through the repo's existing config validator -> parse
 * back and assert every security field value (P1-4). Throws on the first
 * violation. A config that is unknown, ignored or auto-rewritten by mihomo on a
 * critical field is rejected BEFORE mihomo is started.
 *
 * NOTE (P2-7): the repo's `createConfigValidator()` here is the deterministic
 * structural `FakeConfigValidator` — it is a cheap syntax/structural gate ONLY,
 * NOT a complete mihomo validator, and it never proves that the real mihomo
 * binary would accept the config. Before any REAL execution the same config
 * (byte-identical, written to disk untouched) MUST be validated by the real
 * `mihomo -t` against the SAME mihomo binary the probe will spawn, so a
 * structural-pass / semantic-fail config can never reach a spawned mihomo.
 */
export function assertG1MihomoConfig(text: string, expectedDevice: string): void {
  const errors = g1MihomoConfigErrors(text, expectedDevice)
  if (errors.length) {
    throw new G1ProbeError(G1ErrorCode.g1Failed, `unsafe probe config: ${errors.join('; ')}`)
  }
  // Also route through the repo's own config validator (structural gate).
  const repoValidator = createConfigValidator()
  const result = repoValidator.validate(text)
  if (!result.ok) {
    const detail = result.issues.map((i) => i.message).join('; ')
    throw new G1ProbeError(G1ErrorCode.g1Failed, `unsafe probe config (repo validator): ${detail}`)
  }
  // Parse back and assert the final values of the security fields.
  const parsed = parseBackG1MihomoConfig(text)
  const failures: string[] = []
  if (parsed.allowLan !== false) failures.push('allow-lan must be false')
  if (parsed.mode !== 'direct') failures.push('mode must be direct')
  if (parsed.tunEnable !== true) failures.push('tun.enable must be true')
  if (parsed.tunStack !== 'system') failures.push('tun.stack must be system')
  if (parsed.tunDevice !== expectedDevice) failures.push('tun.device must match the probe adapter name')
  if (parsed.autoRoute !== false) failures.push('tun.auto-route must be false')
  if (parsed.autoDetectInterface !== false) failures.push('tun.auto-detect-interface must be false')
  if (parsed.strictRoute !== false) failures.push('tun.strict-route must be false')
  if (parsed.dnsEnable !== false) failures.push('dns.enable must be false')
  if (failures.length) {
    throw new G1ProbeError(G1ErrorCode.g1Failed, `probe config security fields invalid: ${failures.join('; ')}`)
  }
}

// ---------------------------------------------------------------------------
// Wintun native handle + manifest + network snapshot
// ---------------------------------------------------------------------------

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

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Read-only, side-effect-free host network snapshot + diff, used to prove the
 * probe never mutated routes / DNS / system proxy / firewall. Windows-aware; on
 * non-Windows it returns a stable placeholder so the diff is deterministic (the
 * probe only ever runs on Windows anyway).
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
  const keys = new Set<keyof G1NetworkSnapshot>([
    ...(Object.keys(before) as (keyof G1NetworkSnapshot)[]),
    ...(Object.keys(after) as (keyof G1NetworkSnapshot)[])
  ])
  const changed: string[] = []
  for (const key of keys) {
    const a = before[key] ?? 'MISSING'
    const b = after[key] ?? 'MISSING'
    if (a !== b) changed.push(key as string)
  }
  return changed
}

// ---------------------------------------------------------------------------
// Real driver (fail closed to `unsupported` when no native binding)
// ---------------------------------------------------------------------------

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

const unsupportedErr = (msg: string): G1ProbeError => new G1ProbeError(G1ErrorCode.unsupported, msg)

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

  const dllPath = (): string => (wintunDir ? join(wintunDir, `${architecture}-${WINTUN_DLL_NAME}`) : '')

  // Opaque TS handle -> native pointer (P1-2 / P1-3). Only the binding owns the
  // pointer; TS holds the branded handle and never inspects the native value.
  const nativeHandles = new WeakMap<G1OpaqueHandle, unknown>()

  let creatorHandle: G1OpaqueHandle | null = null
  let creatorHandleClosed = false
  let createdIdentity: G1AdapterIdentity | null = null
  let mihomoChild: ChildProcess | null = null
  let mihomoPid: number | null = null

  const bound = (name: string): WintunResolvedSymbol => {
    if (!binding) throw unsupportedErr('native binding not present')
    const sym = binding.resolve(name)
    if (!sym) throw unsupportedErr(`unresolved native symbol ${name}`)
    return sym
  }

  return {
    architecture,
    pid,

    async preflightConflictCheck(target: G1ProbeIdentityTarget): Promise<G1ConflictReport> {
      // Read-only enumeration; the orchestrator guarantees zero change. Requires a
      // native adapter namespace read; fails closed without it.
      if (!binding) throw unsupportedErr('conflict preflight requires a native binding')
      // A real implementation enumerates the same-name adapter, same RequestedGUID,
      // the product probe name prefix and leftover earlier-round probe resources.
      void target
      throw unsupportedErr('conflict preflight enumeration is gated, not wired in this scaffold')
    },

    async loadPinnedWintun(): Promise<{ verified: boolean; digest: string }> {
      // No pinned digest for this arch, or no configured DLL path: fail closed to
      // "not verified" WITHOUT touching the loader or the OS (deliverable B).
      const digest = manifest.digests[architecture]
      if (!digest || !SHA256_HEX.test(digest)) return { verified: false, digest: '' }
      const path = dllPath()
      if (!path) return { verified: false, digest: '' }
      const computed = await sha256File(path)
      if (computed.toLowerCase() !== digest.toLowerCase()) {
        return { verified: false, digest: computed }
      }
      // Only a verified DLL may be loaded — and only when a native binding exists.
      if (!binding) throw unsupportedErr('native binding not present')
      binding.load(path)
      binding.assertSymbols([
        'WintunCreateAdapter',
        'WintunGetAdapterLUID',
        'WintunCloseAdapter',
        'WintunStartSession',
        'WintunEndSession',
        'WintunOpenAdapter'
      ])
      return { verified: true, digest: computed }
    },

    async createAdapter(
      target: G1ProbeIdentityTarget & { tunnelType: string },
      _signal?: AbortSignal
    ): Promise<G1OpaqueHandle> {
      const sym = bound('WintunCreateAdapter')
      const guidBytes = guidToLittleEndianBytes(target.requestedGuid)
      const nativeHandle = sym(target.name, target.tunnelType, guidBytes)
      if (!nativeHandle) throw unsupportedErr('WintunCreateAdapter returned NULL')
      const handle: G1OpaqueHandle = { __g1OpaqueHandle: 'wintun-adapter' }
      nativeHandles.set(handle, nativeHandle)
      creatorHandle = handle
      creatorHandleClosed = false
      createdIdentity = {
        name: target.name,
        requestedGuid: target.requestedGuid,
        canonicalLuid: '' // filled by readAdapterIdentity via the native LUID read
      }
      return handle
    },

    async readAdapterIdentity(handle: G1OpaqueHandle): Promise<G1AdapterIdentity> {
      const nativeHandle = nativeHandles.get(handle)
      if (!nativeHandle) throw unsupportedErr('unrecognised creator handle')
      if (!creatorOpenIdentity()) throw unsupportedErr('no creator handle held')
      // The native binding reads the NET_LUID from the still-open handle via
      // `WintunGetAdapterLUID(handle, &luid)` and returns it as a canonical hex
      // string. Fails closed without a binding.
      void bound('WintunGetAdapterLUID')
      throw unsupportedErr('adapter identity requires a native binding')
    },

    async liveAdapterIdentity(handle: G1OpaqueHandle): Promise<G1AdapterIdentity | null> {
      const nativeHandle = nativeHandles.get(handle)
      if (!nativeHandle || creatorHandleClosed) return null
      // The live adapter behind the still-open creator handle must still carry the
      // recorded Name + RequestedGUID + LUID. Requires a native LUID read.
      if (!creatorOpenIdentity()) return null
      throw unsupportedErr('live adapter identity requires a native binding')
    },

    async startMihomoProbe(identity: G1AdapterIdentity, _signal?: AbortSignal): Promise<{ pid: number }> {
      if (!binding) throw unsupportedErr('mihomo probe requires a native binding')
      const config = buildIsolatedMihomoConfig(identity)
      // Generate -> validate -> parse back -> assert BEFORE mihomo is started (P1-4).
      assertG1MihomoConfig(config, identity.name)
      // A real implementation writes `config` to a runner-temp dir, validates it
      // again on-disk, then spawns `mihomo -d <dir> -f <config>` and keeps the
      // ChildProcess/PID here so stopMihomoProbe can terminate the exact process.
      // That on-disk validation MUST be the real `mihomo -t` against the SAME
      // mihomo binary and a BYTE-IDENTICAL start config file (never a rebuilt /
      // re-serialised copy) — the structural `FakeConfigValidator` above is only a
      // cheap pre-flight, not the semantic gate (P2-7).
      void config
      throw unsupportedErr('mihomo probe spawn is gated, not wired in this scaffold')
    },

    async matchingAdapterCount(identity: G1AdapterIdentity): Promise<number> {
      void bound('WintunOpenAdapter')
      void identity
      throw unsupportedErr('adapter enumeration requires a native binding')
    },

    async pollMihomoReuse(identity: G1AdapterIdentity, timeoutMs: number): Promise<G1ReuseResult> {
      void identity
      void timeoutMs
      throw unsupportedErr('reuse observation requires a native binding')
    },

    async stopMihomoProbe(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
      // Bounded graceful stop; on timeout terminate the EXACT recorded PID and
      // wait for a CONFIRMED exit. Returns true only when the process is verified
      // gone (P1-3); false when it cannot be confirmed. Never throws when nothing
      // was started, so the orchestrator's finally teardown is safe.
      if (!mihomoChild) return true
      const ok = await stopChildGracefully(mihomoChild, timeoutMs, { pid: mihomoPid ?? undefined, signal })
      // Preserve the exact process reference after an unconfirmed stop so the
      // orchestrator/finally can retry instead of certifying absence by amnesia.
      if (ok) {
        mihomoChild = null
        mihomoPid = null
      }
      return ok
    },

    async closeCreatorHandle(handle: G1OpaqueHandle, _signal?: AbortSignal): Promise<void> {
      // The SAME handle create returned must be passed to WintunCloseAdapter, and
      // it must be closed at most once (P1-2). We refuse a non-creator handle.
      if (handle !== creatorHandle) {
        throw unsupportedErr('cannot close a handle that was not returned by createAdapter')
      }
      if (creatorHandleClosed) return
      const nativeHandle = nativeHandles.get(handle)
      if (!nativeHandle) {
        creatorHandleClosed = true // nothing native left to close
        return
      }
      const sym = bound('WintunCloseAdapter')
      sym(nativeHandle)
      nativeHandles.delete(handle)
      creatorHandle = null
      creatorHandleClosed = true
    },

    async adapterStillPresent(identity: G1AdapterIdentity): Promise<boolean> {
      void bound('WintunOpenAdapter')
      void identity
      throw unsupportedErr('adapter presence requires a native binding')
    },

    async mihomoSessionActive(): Promise<boolean> {
      if (!binding) throw unsupportedErr('session activity requires a native binding')
      throw unsupportedErr('session activity is gated, not wired in this scaffold')
    },

    async mihomoStillBoundTo(identity: G1AdapterIdentity): Promise<boolean> {
      void bound('WintunOpenAdapter')
      void identity
      throw unsupportedErr('session binding observation requires a native binding')
    },

    captureNetworkSnapshot,
    networkDiff
  }

  function creatorOpenIdentity(): boolean {
    return creatorHandle !== null && createdIdentity !== null && !creatorHandleClosed
  }
}

/**
 * Structural view of a child process that `stopChildGracefully` needs, so tests
 * can drive the stop path with a stub that never emits a real 'exit' (P1-3). A
 * real `ChildProcess` is structurally assignable.
 */
export interface G1StoppableChild {
  pid?: number | undefined
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeAllListeners(event?: string): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

/** Options for `stopChildGracefully` (injectable for tests). */
export interface StopChildOptions {
  /** PID to SIGKILL after a graceful timeout (defaults to `child.pid`). */
  pid?: number
  /** Final bounded wait for a CONFIRMED exit after SIGKILL (default 500ms). */
  killWaitMs?: number
  /** Liveness probe; defaults to `isProcessAlive`. */
  probeAlive?: (pid: number) => boolean
  /** An aborted/aborting signal cancels the bounded wait (P1-1). */
  signal?: AbortSignal
}

/** True when `pid` still exists (EPERM means it exists but is not signalling-able). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Bounded graceful shutdown of a child process (P1-3).
 *
 * Resolves `true` ONLY when the process is confirmed gone: either a real
 * 'exit'/'close' event fires, or, after SIGKILL, the liveness probe reports the
 * exact PID no longer exists within the final bounded `killWaitMs`. An 'error'
 * event NEVER counts as proof of exit — it only signals that the graceful path
 * is unreliable, so we keep waiting for a genuine exit or the liveness deadline.
 *
 * On a graceful timeout it SIGKILLs the exact recorded PID, then waits a bounded
 * `killWaitMs`, and resolves `false` if the process is still alive. It always
 * clears its timer and removes its listeners once it settles.
 */
export async function stopChildGracefully(
  child: G1StoppableChild,
  timeoutMs: number,
  opts: StopChildOptions = {}
): Promise<boolean> {
  const pid = opts.pid ?? child.pid ?? null
  const killWaitMs = opts.killWaitMs ?? 500
  const probeAlive = opts.probeAlive ?? ((p: number) => isProcessAlive(p))
  const signal = opts.signal ?? null

  return await new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      child.removeAllListeners('exit')
      child.removeAllListeners('close')
      child.removeAllListeners('error')
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ok)
    }
    const onAbort = (): void => finish(false)
    if (signal) {
      if (signal.aborted) {
        finish(false)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // A real exit/close is the only event that CONFIRMS the process is gone.
    child.once('exit', () => finish(true))
    child.once('close', () => finish(true))
    // An 'error' does not prove the process exited; keep waiting for a real
    // exit/close or the liveness deadline.
    child.once('error', () => { /* never confirms exit */ })

    try {
      child.kill('SIGTERM')
    } catch {
      /* fall through to forced terminate */
    }

    // After the graceful window, SIGKILL the exact PID and wait for a CONFIRMED
    // exit (bounded). Never trusts a fixed delay as proof of exit (P1-3).
    timer = setTimeout(() => {
      if (pid !== null) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone — the liveness probe confirms it */
        }
      }
      const start = Date.now()
      const poll = (): void => {
        if (settled) return
        if (pid !== null && !probeAlive(pid)) {
          finish(true)
          return
        }
        if (Date.now() - start >= killWaitMs) {
          finish(false)
          return
        }
        pollTimer = setTimeout(poll, 50)
      }
      poll()
    }, Math.max(0, timeoutMs))
    if (timer.unref) timer.unref()
  })
}

/** Best-effort architecture tag used for evidence. */
function detectArchitecture(): string {
  const arch = process.arch
  if (arch === 'x64') return 'x64'
  if (arch === 'arm64') return 'arm64'
  return arch
}
