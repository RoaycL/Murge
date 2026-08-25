/**
 * Profile and subscription domain models for the configuration manager.
 *
 * A profile is a named mihomo config document that can be imported from a
 * subscription URL, a local file, or authored by hand. Only one profile is
 * *active* at a time (the one the controller would load). The raw YAML document
 * is kept verbatim so unsupported keys and comments survive supported edits.
 */

export type ProfileSourceType = 'url' | 'file' | 'manual'

/** Where a profile came from, WITHOUT any secret material (never a raw token). */
export interface ProfileSubscription {
  type: ProfileSourceType
  /** For `url`: the normalized subscription URL with credentials redacted. Used for display and logs only. */
  url?: string
  /** For `file`: the local path the user imported from (kept for provenance only). */
  path?: string
  /** Subscription expiry as a Unix timestamp (seconds), when reported by the source. */
  expire?: number | null
  /** Traffic/usage envelope reported by a subscription-backed profile. */
  usage?: {
    upload: number
    download: number
    total: number
  } | null
}

/** Immutable metadata describing a stored profile. */
export interface ProfileMeta {
  id: string
  name: string
  source: ProfileSubscription
  /** Size of the stored YAML document in bytes. */
  size: number
  /** Creation time, epoch milliseconds. */
  createdAt: number
  /** Last modification time, epoch milliseconds. */
  updatedAt: number
  /** True when this is the profile the controller would load. */
  active: boolean
}

/** A stored profile: metadata plus the verbatim YAML document. */
export interface Profile {
  meta: ProfileMeta
  /** The raw config document. Never re-serialized wholesale (preserves unknown keys/comments). */
  document: string
}

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationIssue {
  severity: ValidationSeverity
  message: string
  /** 1-based YAML line, when a location can be attributed. */
  line?: number
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

/**
 * Top-level keys a profile document may be edited through.
 *
 * Mirrors `patchableConfigKeys` in `shared/schemas/ipc.ts`. `tun` is deliberately
 * excluded: it is high-privilege network configuration and must never be written
 * from the renderer as free-form text.
 */
export type ConfigEditKey =
  | 'port'
  | 'socks-port'
  | 'mixed-port'
  | 'mode'
  | 'log-level'
  | 'allow-lan'
  | 'ipv6'

/** A single supported scalar edit applied to a profile document. */
export interface ConfigEdit {
  /** Top-level YAML key to set, e.g. `mode` or `mixed-port`. */
  key: ConfigEditKey
  /**
   * The scalar value, as the string written into the document (e.g. `rule`,
   * `7890`, `true`). Validated per key in `parseConfigEdit`.
   */
  value: string
}

/** Renderer request to import a new profile. */
export interface ImportRequest {
  name: string
  /** Raw YAML document to store. */
  document: string
  source: ProfileSubscription
  /** Activate the profile immediately after a successful import. */
  activate?: boolean
}

export type ProfilePatch = Partial<{
  name: string
  source: ProfileSubscription
}>
