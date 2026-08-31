/**
 * Kernel management contract shared across main, preload and renderer.
 *
 * The kernel is a pinned, checksum-verified mihomo build. This module adds a
 * user-facing version manager: a master enable switch plus the ability to run a
 * specific published mihomo version ("specific" channel) instead of the built-in
 * pinned "stable" build. Every install is still verified against the SHA-256 the
 * upstream release publishes for its asset before any binary is extracted, so a
 * specific version can never smuggle in an unverified payload.
 */

export type KernelVersionChannel = 'stable' | 'specific'

/**
 * Snapshot of the kernel manager. The durable choices (enabled / channel /
 * specificVersion) are mirrored from the settings document; the rest is
 * transient runtime state owned by the main-process service.
 */
export interface KernelManagerState {
  /** Master switch: when false the kernel refuses to start. */
  enabled: boolean
  /** Which kernel build the next start will use. */
  channel: KernelVersionChannel
  /** The built-in pinned build, e.g. `v1.19.30`. */
  stableVersion: string
  /** The user-chosen specific version, or null when none is selected yet. */
  specificVersion: string | null
  /** The effective version the next start will run (stable or specific). */
  effectiveVersion: string | null
  /** Fetched published mihomo versions (transient). */
  versions: string[]
  /** Whether a version refresh is in flight. */
  versionsLoading: boolean
  /** Version currently being downloaded/installed, or null when idle. */
  installing: string | null
  /** Last operation error (install/refresh), or null when healthy. */
  error: string | null
}

export const DEFAULT_KERNEL_MANAGER_STATE: Readonly<KernelManagerState> = Object.freeze({
  enabled: true,
  channel: 'stable',
  stableVersion: '',
  specificVersion: null,
  effectiveVersion: null,
  versions: [],
  versionsLoading: false,
  installing: null,
  error: null
})

/** Coerce an untrusted value into a complete {@link KernelManagerState}. */
export function coerceKernelManagerState(value: unknown): KernelManagerState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_KERNEL_MANAGER_STATE }
  const o = value as Record<string, unknown>
  const channel: KernelVersionChannel = o.channel === 'specific' ? 'specific' : 'stable'
  const stableVersion = typeof o.stableVersion === 'string' ? o.stableVersion : ''
  const specificVersion =
    typeof o.specificVersion === 'string' && o.specificVersion.trim().length > 0
      ? o.specificVersion
      : null
  const effectiveVersion =
    typeof o.effectiveVersion === 'string' && o.effectiveVersion.trim().length > 0
      ? o.effectiveVersion
      : channel === 'specific'
        ? specificVersion
        : stableVersion
  return {
    enabled: o.enabled !== false,
    channel,
    stableVersion,
    specificVersion,
    effectiveVersion,
    versions: Array.isArray(o.versions) ? o.versions.filter((v): v is string => typeof v === 'string') : [],
    versionsLoading: o.versionsLoading === true,
    installing: typeof o.installing === 'string' && o.installing.length > 0 ? o.installing : null,
    error: typeof o.error === 'string' && o.error.length > 0 ? o.error : null
  }
}
