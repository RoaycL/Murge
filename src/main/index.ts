/**
 * Murge — Electron main-process entry (Phase 1 migration boundary).
 *
 * The former monolith (≈1900 lines of startup orchestration) is split behind a
 * composition seam:
 * - `electron/bootstrap` performs the module-level shell bootstrap (boot flags,
 *   diagnostics, watchdogs, GPU gating, single-instance lock, userData pinning,
 *   file logging, settings-service construction and the storage warmup chain).
 * - `electron/when-ready` owns the `app.whenReady` service graph and startup
 *   ordering — a behavioral specification (see docs/tauri/phase1/README.md).
 * - Window, tray, update, lifecycle and CI-probe concerns live in their own
 *   adapters under `electron/`.
 *
 * This file stays deliberately thin: the Tauri migration replaces this entry
 * with a Rust shell while the orchestration modules above port unchanged.
 */
import { app } from 'electron'
import { bootstrapShell } from './electron/bootstrap'
import { runWhenReady } from './electron/when-ready'
import { reportFatalStartupError } from './electron/lifecycle-adapter'

const shell = bootstrapShell()

void app.whenReady().then(() => runWhenReady(shell)).catch(async (error) => {
  await reportFatalStartupError(error, () => shell.fileLogs.flush())
})
