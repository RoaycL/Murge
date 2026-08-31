/**
 * Minimal, testable contract for the underlying auto-updater.
 *
 * The real implementation wraps `electron-updater` (which is Electron-bound and
 * hard to unit-test). `UpdateService` depends only on this narrow interface, so
 * tests can drive its state machine with a synchronous fake without importing
 * Electron or the updater package.
 */

/** Normalized events emitted by an {@link UpdaterDriver}. */
export type UpdaterDriverEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes: string | null }
  | { kind: 'not-available' }
  | { kind: 'download-progress'; percent: number; bytesPerSecond: number; transferred: number; total: number | null }
  | { kind: 'downloaded' }
  | { kind: 'error'; message: string }

export interface UpdaterDriver {
  /** Version string of the running build, surfaced to the UI. */
  readonly currentVersion: string
  /**
   * Whether this build can actually reach an update feed. False for dev /
   * unpackaged runs (no `app-update.yml` is baked in), so the service reports a
   * clear "not supported" state instead of throwing on a missing feed.
   */
  readonly supported: boolean
  /** Attach listeners and apply helper flags once, before any check. */
  configure(): void
  /** Kick off a feed check; results arrive as events. */
  check(): void
  /** Start (or resume) downloading the available update in the background. */
  download(): void
  /** Install a fully-downloaded update and restart the app. */
  quitAndInstall(): void
  /** Subscribe to normalized events; returns an unsubscribe function. */
  onEvent(listener: (event: UpdaterDriverEvent) => void): () => void
  dispose(): void
}
