/**
 * Minimal, testable contract for the underlying auto-updater.
 *
 * The real implementation wraps `electron-updater` (which is Electron-bound and
 * hard to unit-test). `UpdateService` depends only on this narrow interface, so
 * tests can drive its state machine with a synchronous fake without importing
 * Electron or the updater package.
 */

import type { UpdateChannel } from '@shared/app-settings'
import type { UpdateProduct } from '@shared/updates'

/** Normalized events emitted by an {@link UpdaterDriver}. */
export type UpdaterDriverEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes: string | null; product?: UpdateProduct }
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
  /** The build this driver runs in. */
  readonly product?: UpdateProduct
  /**
   * Follow another release channel. Drops any offer or staged installer from
   * the previous channel; the caller starts a fresh check. Drivers without
   * channels omit it.
   */
  setChannel?(channel: UpdateChannel): void
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
  /**
   * Detach; may settle later when a staged installer is being handed off.
   * `skipInstall` (Windows session ending) leaves a staged installer alone:
   * an administrator prompt must never hold up a logoff or shutdown.
   */
  dispose(options?: { skipInstall?: boolean }): void | Promise<void>
}
