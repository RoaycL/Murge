/**
 * Sub-Store integration contract (初步接入).
 *
 * Sub-Store (https://github.com/sub-store-org/Sub-Store) is an external
 * subscription manager. The app bundles it on demand: the main process
 * downloads the official backend bundle and frontend distribution from the
 * pinned GitHub releases into the app-data namespace, then runs the backend in
 * a Node worker thread with MERGE mode enabled so ONE local loopback port
 * serves BOTH the frontend (static) and the API (same origin — no CORS).
 *
 * Security posture:
 * - The backend binds 127.0.0.1 only (no LAN exposure).
 * - Worker env never inherits the main process environment.
 * - Download sources are the official `sub-store-org` GitHub releases only.
 */

export type SubStorePhase = 'idle' | 'downloading' | 'starting' | 'running' | 'error'

export interface SubStoreAssetVersions {
  /** Backend bundle release tag, e.g. `2.38.2` (no `v` prefix). */
  backend: string
  /** Frontend distribution release tag, e.g. `2.31.2`. */
  frontend: string
}

/** Snapshot the renderer observes through the sub-store IPC surface. */
export interface SubStoreState {
  /** Mirrors the persisted `subStoreEnabled` app setting. */
  enabled: boolean
  /** Mirrors the persisted `subStoreUseProxy` app setting. */
  useProxy: boolean
  phase: SubStorePhase
  /** The single merged frontend+API loopback port while running. */
  port: number | null
  /** Versions of the downloaded assets; null when never downloaded. */
  version: SubStoreAssetVersions | null
  /** True when both assets are present on disk (backend bundle + frontend index). */
  assetsReady: boolean
  error: string | null
}

/** Default pinned release tags (no `v` prefix; Sub-Store tags are bare semver). */
export const SUB_STORE_BACKEND_DEFAULT_TAG = '2.38.2'
export const SUB_STORE_FRONTEND_DEFAULT_TAG = '2.31.2'
/** GitHub-computed digests pinned with the default executable assets. */
export const SUB_STORE_BACKEND_DEFAULT_DIGEST =
  'sha256:f1e1430313c0d5df6f937f5d7f3a90b92efec67bc96e1797502c50f94ec9527a'
export const SUB_STORE_FRONTEND_DEFAULT_DIGEST =
  'sha256:a30a34fa0af71e8e95a01f25a2b8efeb98942cc6ee3ba2761a000484ffe073c3'

/** Base port for the merged frontend+API listener; increments while busy. */
export const SUB_STORE_PORT_BASE = 38324

/** Health-check budget for the worker to come up (download excluded). */
export const SUB_STORE_START_TIMEOUT_MS = 20_000

/** Budget for one GitHub asset/API request. */
export const SUB_STORE_FETCH_TIMEOUT_MS = 60_000

/** GitHub API endpoint listing the latest backend release. */
export const SUB_STORE_BACKEND_LATEST_API =
  'https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest'
/** GitHub API endpoint listing the latest frontend release. */
export const SUB_STORE_FRONTEND_LATEST_API =
  'https://api.github.com/repos/sub-store-org/Sub-Store-Front-End/releases/latest'

export const SUB_STORE_BACKEND_ASSET = 'sub-store.bundle.js'
export const SUB_STORE_FRONTEND_ASSET = 'dist.zip'

export function subStoreBackendReleaseApi(tag: string): string {
  return `https://api.github.com/repos/sub-store-org/Sub-Store/releases/tags/${tag}`
}

export function subStoreFrontendReleaseApi(tag: string): string {
  return `https://api.github.com/repos/sub-store-org/Sub-Store-Front-End/releases/tags/${tag}`
}

/** Backend bundle download URL for a release tag. */
export function subStoreBackendDownloadUrl(tag: string): string {
  return `https://github.com/sub-store-org/Sub-Store/releases/download/${tag}/${SUB_STORE_BACKEND_ASSET}`
}

/** Frontend distribution (zip) download URL for a release tag. */
export function subStoreFrontendDownloadUrl(tag: string): string {
  return `https://github.com/sub-store-org/Sub-Store-Front-End/releases/download/${tag}/${SUB_STORE_FRONTEND_ASSET}`
}

/** Sub-Store release tags are bare semver (`2.38.2`), unlike mihomo's `v` prefix. */
export function isValidSubStoreTag(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)
}

/**
 * The single merged origin the renderer embeds: the frontend reads the `api`
 * query parameter as its backend base, and in merge mode the API lives on the
 * same origin — so both point at the identical URL (same-origin, no CORS).
 */
export function subStoreMergedOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function subStoreMergedUrl(port: number): string {
  const origin = subStoreMergedOrigin(port)
  return `${origin}/?api=${origin}`
}
