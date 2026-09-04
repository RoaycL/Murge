/**
 * Controlled mihomo geodata settings (Phase 12, geodata resources — part 1).
 *
 * A typed, persisted model over a small allowlist of mihomo's *geodata* keys —
 * `geodata-mode`, `geoip-mode`, `geo-auto-update`, `geo-update-interval` and the
 * optional `geo-x-url` source template. It is applied every time the runtime
 * kernel config is generated, through the same configuration-enhancement
 * pipeline as DNS/sniffer/controlled core settings.
 *
 * `geodata-mode` controls whether mihomo resolves GEOIP / GEOSITE rule types
 * against bundled binary databases (`geoip.dat` / `geosite.dat`) rather than
 * inline text rules; `geoip-mode` selects between the memory-conservative and
 * the standard GeoIP matcher; `geo-auto-update` / `geo-update-interval` drive
 * mihomo's own geodata refresh; `geo-x-url` is the HTTPS source template used to
 * fetch those databases. None of these can bind a public listener, install a
 * route, or mutate the host network — they are pure runtime policy knobs, so they
 * are safe to carry into the loopback-only main kernel.
 *
 * The model is authoritative when `enabled` is true: the generated runtime
 * config reflects these values (read-back), overriding whatever the active
 * profile happened to set for the same keys (conflict handling). The
 * `geo-x-url` is a genuine optional override — when it is empty the profile's own
 * geodata source is left untouched rather than being wiped. When `enabled` is
 * false the enhancement is skipped entirely and the profile's own values are
 * preserved.
 *
 * The geodata *source registry* (HTTPS allowlist, hashes, atomic replacement,
 * manual refresh, bounded scheduling) is tracked separately as a P2 resource
 * concern and is NOT part of this controlled-settings model.
 */

/** mihomo `geoip-mode` (GeoIP database memory strategy). */
export type GeoipMode = 'memconservative' | 'standard'

export const GEOIP_MODES: readonly GeoipMode[] = ['memconservative', 'standard']

/** Bounds for mihomo `geo-update-interval` (hours). */
export const MIN_UPDATE_INTERVAL_HOURS = 1
export const MAX_UPDATE_INTERVAL_HOURS = 168
export const DEFAULT_UPDATE_INTERVAL_HOURS = 24

/** The complete typed controlled-geodata-settings model. */
export interface GeodataSettings {
  /** Master switch. When false the enhancement is skipped entirely. */
  enabled: boolean
  /** mihomo `geodata-mode` (binary-geodata rule matching vs inline text). */
  geodataMode: boolean
  /** mihomo `geoip-mode`. */
  geoipMode: GeoipMode
  /** mihomo `geo-auto-update`. */
  autoUpdate: boolean
  /** mihomo `geo-update-interval` in hours (clamped to the allowed bounds). */
  updateIntervalHours: number
  /** Deprecated single-source field retained only to migrate older settings. */
  geoxUrl: string
  geoxUrls: { geoip: string; mmdb: string; geosite: string; asn: string }
}

export const DEFAULT_GEOX_URLS = Object.freeze({
  geoip: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat',
  mmdb: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb',
  geosite: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
  asn: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb'
})

/**
 * Safe default: the enhancement is disabled, so a profile's own geodata keys are
 * preserved verbatim until the owner opts in. The values emitted on enable are
 * conservative (binary geodata off, standard GeoIP matcher, no auto-update,
 * 24h interval, no custom source URL).
 */
export const EMPTY_GEODATA_SETTINGS: Readonly<GeodataSettings> = Object.freeze({
  enabled: false,
  geodataMode: false,
  geoipMode: 'standard',
  autoUpdate: false,
  updateIntervalHours: DEFAULT_UPDATE_INTERVAL_HOURS,
  geoxUrl: '',
  geoxUrls: { ...DEFAULT_GEOX_URLS }
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An HTTPS or HTTP URL, used only as a source template (never a fetch target). */
function isValidSourceUrl(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return true // empty is allowed: means "keep the profile's"
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Coerce arbitrary input into a valid model, falling back to safe defaults. */
export function coerceGeodataSettings(input: unknown): GeodataSettings {
  const source = isRecord(input) ? input : {}
  const asBool = (key: keyof GeodataSettings): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : (EMPTY_GEODATA_SETTINGS[key] as boolean)
  const asGeoipMode = (): GeoipMode =>
    GEOIP_MODES.includes(source.geoipMode as GeoipMode) ? (source.geoipMode as GeoipMode) : EMPTY_GEODATA_SETTINGS.geoipMode
  const asInterval = (): number => {
    const raw = source.updateIntervalHours
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_UPDATE_INTERVAL_HOURS && raw <= MAX_UPDATE_INTERVAL_HOURS) {
      return raw
    }
    return DEFAULT_UPDATE_INTERVAL_HOURS
  }
  const asUrl = (): string => {
    const raw = source.geoxUrl
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      return isValidSourceUrl(trimmed) ? trimmed : ''
    }
    return ''
  }

  return {
    enabled: asBool('enabled'),
    geodataMode: asBool('geodataMode'),
    geoipMode: asGeoipMode(),
    autoUpdate: asBool('autoUpdate'),
    updateIntervalHours: asInterval(),
    geoxUrl: asUrl(),
    geoxUrls: (() => {
      const value = isRecord(source.geoxUrls) ? source.geoxUrls : {}
      return Object.fromEntries(Object.entries(DEFAULT_GEOX_URLS).map(([key, fallback]) => {
        const candidate = value[key]
        return [key, typeof candidate === 'string' && isValidSourceUrl(candidate) && candidate.trim() ? candidate.trim() : fallback]
      })) as GeodataSettings['geoxUrls']
    })()
  }
}

/* -------------------------------------------------------------------------- */
/* Config generation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the mihomo geodata keys (as a plain object) for the model. The
 * always-owned keys are emitted unconditionally because the model is authoritative
 * when enabled; the optional `geo-x-url` is emitted only when a source URL was set
 * (an empty value would otherwise wipe a profile-provided source). This gives
 * read-back for everything the model owns and conflict handling for everything it
 * does not.
 */
export function buildGeodataBlock(settings: GeodataSettings): Record<string, unknown> {
  const block: Record<string, unknown> = {
    'geodata-mode': settings.geodataMode,
    'geodata-loader': settings.geoipMode,
    'geo-auto-update': settings.autoUpdate,
    'geo-update-interval': settings.updateIntervalHours
  }
  block['geox-url'] = { ...settings.geoxUrls }
  return block
}
