import { app, dialog, BrowserWindow } from 'electron'
import { brand } from '@shared/brand'
import { runQuitFlow } from '../quit-guard'
import type { TunStatus } from '@shared/tun'
import type { ApplicationState } from './runtime-state'

/**
 * Lifecycle adapter: the application quit path of the Electron shell.
 *
 * Extracted verbatim from the former monolithic `src/main/index.ts`
 * (Phase 1 boundary). Ordering invariants are load-bearing:
 * - Restore the OWNED system proxy BEFORE the kernel stops (the registry must
 *   never aim at a port that is about to close).
 * - A failed restore blocks the quit (except during session-end, where Windows
 *   may kill us anyway and the next launch's init() restores from the backup).
 * - Every shutdown signal joins the same idempotent promise on the state
 *   container, so concurrent session-end/shutdown/before-quit cannot interleave.
 */
export interface LifecycleDeps {
  state: ApplicationState
  /** Drain + flush file logs (shutdown marker + final flush). */
  flushLogs: () => Promise<void>
  /** Drains profile/selection queue before teardown (reads live state). */
  waitForProfileOperations: () => Promise<void>
}

/** Lifecycle surface consumed by the entry point and other adapters. */
export interface LifecycleAdapter {
  beginApplicationShutdown: (sessionEnding: boolean) => Promise<void>
  restoreNetworkBeforeQuit: () => Promise<boolean>
  registerLifecycleListeners: () => void
}

const MAX_QUIT_RESTORE_ATTEMPTS = 3
const QUIT_RESTORE_RETRY_DELAY_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Restore a owned system proxy (if any) before tearing down the controller. The
 * proxy must never be left pointing at a port that is about to close, so restore
 * happens first; a genuine failure is retried a bounded number of times. Returns
 * true once the proxy is confirmed restored (or there was nothing owned — conflict
 * is treated as safe, since the proxy no longer points at us). Returns false when
 * the owned proxy could NOT be restored.
 */
export async function restoreSystemProxyBeforeQuit(state: ApplicationState): Promise<boolean> {
  if (!state.systemProxy) return true
  for (let attempt = 1; attempt <= MAX_QUIT_RESTORE_ATTEMPTS; attempt++) {
    try {
      await state.systemProxy.restoreBeforeKernelUnavailable()
      return true
    } catch (error) {
      console.error(
        `[system-proxy] restore during quit failed (attempt ${attempt}/${MAX_QUIT_RESTORE_ATTEMPTS}):`,
        error
      )
      if (attempt < MAX_QUIT_RESTORE_ATTEMPTS) await delay(QUIT_RESTORE_RETRY_DELAY_MS)
    }
  }
  return false
}

export function createLifecycleAdapter(deps: LifecycleDeps): LifecycleAdapter {
  const { state } = deps

  async function restoreNetworkBeforeQuit(): Promise<boolean> {
    // Inside the ONE mode-transition queue, so a concurrent renderer start/stop
    // can never interleave with the shutdown sequence.
    const task = async (): Promise<boolean> => {
      // Restore the owned system proxy FIRST, while the live host (the elevated
      // TUN child or the main kernel) still holds the unified mixed port. This
      // mirrors every other teardown path (single-kernel-gateway.stop,
      // ordered-kernel-gateway.stop): the registry must never aim at a port that
      // is about to close. The quit path never resumes the main kernel, so
      // stopping the TUN child first would leave a bounded dead-port window.
      const restored = await restoreSystemProxyBeforeQuit(state)
      if (state.tunCoordinator) {
        try {
          const status: TunStatus = await state.tunCoordinator.emergencyDisable()
          if (status.phase !== 'configured' && status.phase !== 'unsupported') {
            console.error('[tun] TUN stop was not confirmed during quit:', status.phase)
          }
        } catch (error) {
          console.error('[tun] restore during quit failed:', error)
        }
      }
      return restored
    }
    if (state.modeTransition) return state.modeTransition.runExclusive(task)
    return task()
  }

  async function beginApplicationShutdown(sessionEnding: boolean): Promise<void> {
    if (state.shutdownPromise) return state.shutdownPromise
    state.isQuitting = true
    state.shutdownPromise = (async () => {
      // Proxy selections share the profile mutation queue through their durable
      // per-profile write. Drain accepted work before tearing IPC and storage down.
      await deps.waitForProfileOperations()
      // Restore a owned system proxy FIRST, so the OS proxy is never left pointing
      // at a controller port that is about to close. If the restore cannot be
      // confirmed, we must NOT stop the kernel and must NOT quit: leaving a
      // dead-port proxy behind is worse than holding the app open. Reset the
      // guard, keep the window + kernel alive, surface the failure (the system
      // proxy onStatus listener already broadcast restore-failed to the renderer),
      // and let the user fix it before retrying the quit.
      const result = await runQuitFlow({
        restore: restoreNetworkBeforeQuit,
        stopKernel: async () => {
          // Inside the same mode queue as the restore step, so a queued renderer
          // transition cannot interleave with the shutdown's kernel stop.
          const stop = async (): Promise<void> => {
            await state.kernel?.stop()
          }
          if (state.modeTransition) await state.modeTransition.runExclusive(stop)
          else await stop()
        },
        dispose: async () => {
          try {
            state.tunExitMonitor?.stop()
            state.tunExitMonitor = null
            state.disposeRuntimeAppearance?.()
            state.disposeRuntimeAppearance = null
            state.trayController?.dispose()
            state.disposeIpc?.()
            state.updateService?.dispose()
            await state.usageHistoryServiceRef?.dispose()
            if (state.proxyGuardTimer) {
              clearInterval(state.proxyGuardTimer)
              state.proxyGuardTimer = null
            }
            state.networkDetector?.stop()
            state.networkDetector = null
            state.runtimeIntentRecovery?.stop()
            state.runtimeIntentRecovery = null
            state.subStoreServiceRef?.dispose()
            state.subStoreServiceRef = null
            state.mihomo?.dispose()
            await state.mockServer?.close()
          } catch (error) {
            console.error('[mihomo] failed to stop mock controller during quit:', error)
          } finally {
            state.trayController = null
            state.disposeIpc = null
            state.updateService = null
            state.usageHistoryServiceRef = null
            state.waitForProfileOperations = null
            await deps.flushLogs()
          }
        },
        // Session-end is already inside the Windows logoff/shutdown path; app.exit
        // avoids re-entering before-quit after the bounded cleanup completes.
        quit: () => sessionEnding ? app.exit(0) : app.quit(),
        onCleanupError: (error, step) => console.error(`[quit-guard] ${step} failed during quit:`, error)
      })
      if (result === 'restore-failed') {
        state.shutdownPromise = null
        if (sessionEnding) {
          // Windows may terminate the process immediately. Preserve the proxy
          // backup/TUN journal so init() can restore them before replaying the
          // saved user intent on the next launch.
          await deps.flushLogs()
          app.exit(0)
          return
        }
        state.isQuitting = false
        const window = state.mainWindow ?? BrowserWindow.getAllWindows()[0]
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
        return
      }
    })()
    return state.shutdownPromise
  }

  function registerLifecycleListeners(): void {
    // Give the kernel a bounded chance to shut down and release its temp config
    // before the process exits. Without this the child could outlive the GUI and
    // keep a port (and a secret-bearing temp dir) behind. The guard flag makes the
    // flow idempotent: block the first quit, stop the kernel, then really quit.
    app.on('before-quit', (event) => {
      if (state.isQuitting) return
      event.preventDefault()
      void beginApplicationShutdown(false)
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
  }

  return { beginApplicationShutdown, restoreNetworkBeforeQuit, registerLifecycleListeners }
}

/** Fatal-startup surface: packaged GUI apps have no attached console. */
export async function reportFatalStartupError(error: unknown, flushLogs: () => Promise<void>): Promise<void> {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
  console.error('[startup] fatal initialization failure:', error)
  await flushLogs()
  dialog.showErrorBox(`${brand.productName} failed to start`, message)
  app.exit(1)
}
