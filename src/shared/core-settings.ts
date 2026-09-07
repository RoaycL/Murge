/**
 * Controlled mihomo core settings (Phase 12, controlled core settings).
 *
 * Migration of a small, explicitly allowlisted set of mihomo *core* runtime keys
 * into a typed, persisted model the user can edit — without ever editing the
 * subscription source profile, and without ever exposing a key that would mutate
 * the host network stack.
 *
 * The main kernel stays loopback-only. Every one of these keys is a pure mihomo
 * runtime knob (log verbosity, IPv6 handling, concurrent dialing, unified delay
 * in proxy tests, process-name lookup and optional outbound interface). None can bind a public
 * listener, install a route, or touch the OS registry / adapters.
 *
 * The model is authoritative when `enabled` is true: the generated runtime
 * config reflects these values (read-back), overriding whatever the active
 * profile happened to set for the same keys (conflict handling). When `enabled`
 * is false the enhancement is skipped entirely and the profile's own values are
 * preserved.
 */

import type { MihomoLogLevel } from './schemas/log-level'

export const MIHOMO_LOG_LEVELS: readonly MihomoLogLevel[] = ['silent', 'error', 'warning', 'info', 'debug']

/** mihomo `find-process-mode` (process-name resolution during rule matching). */
export type FindProcessMode = 'off' | 'strict' | 'always'

export const FIND_PROCESS_MODES: readonly FindProcessMode[] = ['off', 'strict', 'always']

/** The complete typed controlled-settings model. */
export interface CoreSettings {
  /** Master switch. When false the enhancement is skipped entirely. */
  enabled: boolean
  /** mihomo `log-level`. */
  logLevel: MihomoLogLevel
  /** mihomo `ipv6` (whether mihomo resolves/routes IPv6 through its own stack). */
  ipv6: boolean
  /** mihomo `tcp-concurrent` (concurrent dialing for outbound connections). */
  tcpConcurrent: boolean
  /** mihomo `unified-delay` (unified delay used in proxy/delay tests). */
  unifiedDelay: boolean
  /** mihomo `find-process-mode`. */
  findProcessMode: FindProcessMode
  /** Optional mihomo `interface-name`; empty keeps automatic route selection. */
  interfaceName: string
  /** Mixed inbound used by the app and Windows system proxy. */
  mixedPort: number
  /** Dedicated SOCKS5 inbound. */
  socksPort: number
  /** Dedicated HTTP inbound. */
  httpPort: number
  /** Controller listen address. The app itself always connects through loopback. */
  controllerHost: '127.0.0.1' | '0.0.0.0'
  /** Controller port. */
  controllerPort: number
  /** Persisted controller secret; empty means generate one on next app launch. */
  controllerSecret: string
  /** Download and serve the managed MetaCubeXD controller panel. */
  controllerPanel: boolean
  /** Permit proxy inbounds to listen on the LAN. */
  allowLan: boolean
}

/**
 * Safe default: the enhancement is disabled, so a profile's own core keys are
 * preserved verbatim until the owner opts in. The individual values that would
 * be written on enable are conservative (no IPv6, no concurrent dialing, no
 * unified delay, process-name lookup off, `info` log level).
 */
export const EMPTY_CORE_SETTINGS: Readonly<CoreSettings> = Object.freeze({
  enabled: false,
  logLevel: 'info',
  ipv6: false,
  tcpConcurrent: false,
  unifiedDelay: false,
  findProcessMode: 'off',
  interfaceName: '',
  mixedPort: 7890,
  socksPort: 7891,
  httpPort: 7892,
  controllerHost: '127.0.0.1',
  controllerPort: 9090,
  controllerSecret: '',
  controllerPanel: false,
  allowLan: false
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce arbitrary input into a valid model, falling back to safe defaults. */
export function coerceCoreSettings(input: unknown): CoreSettings {
  const source = isRecord(input) ? input : {}
  const asBool = (key: keyof CoreSettings): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : (EMPTY_CORE_SETTINGS[key] as boolean)
  const asEnum = <T extends string>(key: keyof CoreSettings, allowed: readonly T[], fallback: T): T =>
    allowed.includes(source[key] as T) ? (source[key] as T) : fallback
  const asLogLevel = (): MihomoLogLevel =>
    (MIHOMO_LOG_LEVELS as readonly MihomoLogLevel[]).includes(source.logLevel as MihomoLogLevel)
      ? (source.logLevel as MihomoLogLevel)
      : EMPTY_CORE_SETTINGS.logLevel
  const asPort = (key: 'mixedPort' | 'controllerPort', fallback: number): number =>
    Number.isInteger(source[key]) && (source[key] as number) >= 1024 && (source[key] as number) <= 65535
      ? (source[key] as number)
      : fallback
  const asRequiredPort = (key: 'httpPort' | 'socksPort', fallback: number): number =>
    Number.isInteger(source[key]) && (source[key] as number) >= 1024 && (source[key] as number) <= 65535
      ? (source[key] as number)
      : fallback

  const result: CoreSettings = {
    enabled: asBool('enabled'),
    logLevel: asLogLevel(),
    ipv6: asBool('ipv6'),
    tcpConcurrent: asBool('tcpConcurrent'),
    unifiedDelay: asBool('unifiedDelay'),
    findProcessMode: asEnum('findProcessMode', FIND_PROCESS_MODES, 'off'),
    interfaceName: typeof source.interfaceName === 'string'
      ? source.interfaceName.trim().slice(0, 255)
      : '',
    mixedPort: asPort('mixedPort', EMPTY_CORE_SETTINGS.mixedPort),
    socksPort: asRequiredPort('socksPort', EMPTY_CORE_SETTINGS.socksPort),
    httpPort: asRequiredPort('httpPort', EMPTY_CORE_SETTINGS.httpPort),
    controllerHost: source.controllerHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
    controllerPort: asPort('controllerPort', EMPTY_CORE_SETTINGS.controllerPort),
    controllerSecret: typeof source.controllerSecret === 'string' && /^(?:|[0-9a-f]{64})$/.test(source.controllerSecret)
      ? source.controllerSecret
      : '',
    controllerPanel: asBool('controllerPanel'),
    allowLan: asBool('allowLan')
  }
  const activePorts = [result.mixedPort, result.socksPort, result.httpPort, result.controllerPort]
  if (new Set(activePorts).size !== activePorts.length) {
    result.mixedPort = EMPTY_CORE_SETTINGS.mixedPort
    result.socksPort = EMPTY_CORE_SETTINGS.socksPort
    result.httpPort = EMPTY_CORE_SETTINGS.httpPort
    result.controllerPort = EMPTY_CORE_SETTINGS.controllerPort
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* Config generation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the mihomo core keys (as a plain object) for the model. Every key is
 * emitted unconditionally, because the model is authoritative when enabled: the
 * set of allowlisted keys is exactly the runtime config block the main kernel
 * should enforce.
 */
export function buildCoreSettingsBlock(settings: CoreSettings): Record<string, unknown> {
  const block: Record<string, unknown> = {
    'log-level': settings.logLevel,
    ipv6: settings.ipv6,
    'tcp-concurrent': settings.tcpConcurrent,
    'unified-delay': settings.unifiedDelay,
    'find-process-mode': settings.findProcessMode
  }
  if (settings.interfaceName) block['interface-name'] = settings.interfaceName
  return block
}
