import { isMap, parseDocument, stringify } from 'yaml'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import { SECRET_PATTERN } from './mihomo-config'
import type { CoreSettings } from '../../shared/core-settings'
import { buildCoreSettingsBlock } from '../../shared/core-settings'
import type { GeodataSettings } from '../../shared/geodata'
import { buildGeodataBlock } from '../../shared/geodata'

/**
 * Runtime transform for a user-provided mihomo profile.
 *
 * The strict Phase-7 generator (`generateMihomoConfig`) exists for the
 * controlled-safe milestone, but it never carries the user's proxies, groups,
 * providers or rules — so the live controller the UI reads reports none of
 * them. This module turns the ACTIVE profile document into a runtime config that
 *
 *  - keeps every content section (`proxies`, `proxy-groups`, `proxy-providers`,
 *    `rule-providers`, `rules`, `dns` for resolution, `mode`, …), and
 *  - enforces the main-kernel safety boundary (loopback-only, never mutates the
 *    host network) by neutralizing the blocks that would bind publicly or route
 *    globally:
 *      * `tun` is dropped (global TUN routing belongs to the separate TunService
 *        / MihomoOwnedTunAdapter path, which is mutually exclusive with the main
 *        kernel and owns its own config via `generateMihomoTunConfig`).
 *      * `listeners` is dropped (public socks/http listeners),
 *      * `dns.listen` is dropped (avoid binding a public DNS server; mihomo still
 *        uses the nameservers for resolution),
 *      * `redir-port` / `tproxy-port` are dropped (transparent-proxy binds),
 *      * `external-controller` is forced to loopback + the app-allocated port,
 *      * `mixed-port` is forced to the app-allocated non-privileged port,
 *      * `secret` is forced to the caller's kernel secret,
 *      * `allow-lan` is forced to false (loopback-only proxies).
 *      * `bind-address` is forced to 127.0.0.1 as defense in depth.
 *
 * The document is parsed with `merge: true` so YAML anchors / merge keys
 * (`<<: *anchor`) resolve into their merged values; the runtime artifact is then
 * re-serialized. This expands anchor/merge helpers (value-equivalent — mihomo
 * sees the merged result either way) but guarantees the safety-override keys are
 * authoritative, which would be unreliable with line-surgical edits. The stored
 * profile is left verbatim; only the runtime copy is rebuilt.
 */

export interface ProfileKernelConfigOptions {
  mixedPort: number
  controllerPort: number
  secret: string
  /**
   * Controlled mihomo core settings. When the model is `enabled` its allowlisted
   * core keys (log-level, ipv6, tcp-concurrent, unified-delay, find-process-mode)
   * are authoritative in the runtime config — overriding what the profile set.
   * When `disabled` (or absent) the profile's own keys are preserved.
   */
  core?: CoreSettings
  /**
   * Controlled mihomo geodata settings. When the model is `enabled` its
   * allowlisted geodata keys (geodata-mode, geoip-mode, geo-auto-update,
   * geo-update-interval and an optional geo-x-url) are authoritative in the
   * runtime config — overriding what the profile set. When `disabled` (or
   * absent) the profile's own keys are preserved.
   */
  geodata?: GeodataSettings
}

function invalid(message: string): never {
  throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, message)
}

/**
 * Collect structural errors for a profile-backed runtime config WITHOUT rejecting
 * legitimate mihomo sections. Unlike the strict validator, unknown top-level
 * keys and YAML aliases are accepted (they are normal mihomo constructs that
 * this transform deliberately carries). It fails on the cheap, unambiguous
 * malformation classes plus a missing content section, so an empty or degenerate
 * document can never silently start mihomo.
 */
export function profileKernelConfigErrors(text: string): string[] {
  const errors: string[] = []
  if (text.trim().length === 0) {
    return ['配置文档为空']
  }

  const doc = parseDocument(text, { merge: true, uniqueKeys: true })
  for (const err of doc.errors) {
    errors.push(`YAML 解析错误: ${err.message.split('\n')[0]}`)
  }
  if (!isMap(doc.contents)) {
    errors.push('配置顶层必须是一个 YAML 映射')
    return errors
  }

  const keys = new Set<string>()
  for (const item of doc.contents.items) {
    const keyNode = item.key
    if (keyNode && typeof keyNode === 'object' && 'value' in keyNode) {
      const value = (keyNode as { value: unknown }).value
      if (typeof value === 'string') keys.add(value)
    }
  }

  const hasContent =
    keys.has('proxies') ||
    keys.has('proxy-groups') ||
    keys.has('proxy-providers') ||
    keys.has('rules')
  if (!hasContent) {
    errors.push('文档缺少 proxies、proxy-groups、proxy-providers 或 rules 段')
  }

  return [...new Set(errors)]
}

/**
 * Turn a user profile document into a safe loopback-only runtime config. Content
 * sections are preserved; the system-mutating blocks are neutralized and the
 * app-critical listener/auth keys are forced. The document must already be
 * structurally valid (the import validator plus this function's own
 * {@link profileKernelConfigErrors} gate it).
 */
export function buildProfileKernelConfig(
  document: string,
  options: ProfileKernelConfigOptions
): string {
  const { mixedPort, controllerPort, secret } = options
  if (!Number.isInteger(mixedPort) || mixedPort < 1024 || mixedPort > 65535) {
    invalid(`invalid mixed-port: ${mixedPort}`)
  }
  if (!Number.isInteger(controllerPort) || controllerPort < 1024 || controllerPort > 65535) {
    invalid(`invalid controller-port: ${controllerPort}`)
  }
  if (Number.isInteger(mixedPort) && Number.isInteger(controllerPort) && mixedPort === controllerPort) {
    invalid('mixed-port and external-controller port must differ')
  }
  if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
    invalid('secret must be a 64-character lowercase hex string')
  }

  const doc = parseDocument(document, { merge: true, uniqueKeys: true })
  if (doc.errors.length > 0) {
    invalid(`配置解析失败：${doc.errors.map((e) => e.message.split('\n')[0]).join('；')}`)
  }
  // Resolve aliases / merge keys. An unresolvable anchor (a genuinely broken
  // config, or a provider that redefines an alias) surfaces as a thrown error
  // here rather than a parse error — convert it to a clean fail-closed rejection.
  let data: unknown
  try {
    data = doc.toJS()
  } catch (error) {
    invalid(`配置解析失败：${(error as Error).message.split('\n')[0]}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    invalid('配置顶层必须是一个 YAML 映射')
  }
  const config = data as Record<string, unknown>

  // --- Neutralize host-network mutation (main kernel stays loopback-only) ---
  // The desktop main kernel owns exactly one proxy inbound and one authenticated
  // controller. A subscription may legitimately contain its own listening
  // ports/server shortcuts for use in another client, but carrying them into this
  // runtime copy would create port conflicts or an unauthenticated side channel.
  // Keep the stored profile verbatim; strip every extra inbound from this copy.
  for (const key of [
    'port',
    'socks-port',
    'redir-port',
    'tproxy-port',
    'listeners',
    'tun',
    'ss-config',
    'vmess-config',
    'tuic-server'
  ]) {
    delete config[key]
  }

  // These API variants create additional controller surfaces. In particular,
  // mihomo's Unix socket, Windows named pipe and external DoH endpoint do not
  // authenticate with `secret`, so none may be inherited from a profile.
  for (const key of [
    'external-controller-unix',
    'external-controller-pipe',
    'external-controller-tls',
    'external-controller-routing-mark',
    'external-doh-server'
  ]) {
    delete config[key]
  }
  if (config.dns && typeof config.dns === 'object' && !Array.isArray(config.dns)) {
    delete (config.dns as Record<string, unknown>).listen
  }
  // --- Force the app-critical listener/auth keys ---
  config['mixed-port'] = mixedPort
  config['external-controller'] = `127.0.0.1:${controllerPort}`
  config['allow-lan'] = false
  config['bind-address'] = '127.0.0.1'
  config.secret = secret
  config.mode = typeof config.mode === 'string' && config.mode === 'rule' ? config.mode : 'rule'

  // --- Controlled core settings (read-back + conflict handling) ---
  // When the owner has opted in, the allowlisted core keys are authoritative:
  // they override whatever the profile set (conflict handling) and the runtime
  // config therefore reflects the model (read-back). When disabled the profile's
  // own values are left untouched.
  if (options.core?.enabled) {
    Object.assign(config, buildCoreSettingsBlock(options.core))
  }

  // --- Controlled geodata settings (read-back + conflict handling) ---
  // Same contract as core settings: an enabled model is authoritative for the
  // geodata keys it owns (geodata-mode, geoip-mode, geo-auto-update,
  // geo-update-interval, and geo-x-url only when a URL was chosen); disabled
  // leaves the profile's own values untouched.
  if (options.geodata?.enabled) {
    Object.assign(config, buildGeodataBlock(options.geodata))
  }

  return stringify(config)
}
