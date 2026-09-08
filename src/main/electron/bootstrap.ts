import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { DEFAULT_APP_SETTINGS } from '@shared/app-settings'
import { migrateLegacyAppData, appDataRoot, resolveRuntimeProfileRoot } from '../storage/app-data'
import { createApplicationState, type ApplicationState } from './runtime-state'
import {
  parseBootFlags,
  writeBootDiagnostics,
  armPackagingSmokeWatchdog,
  armRestoreWatchdog,
  shouldDisableHardwareAcceleration,
  type BootFlags
} from './boot-flags'
import { createWindowAdapter, type WindowAdapter } from './window-adapter'
import { createLifecycleAdapter, type LifecycleAdapter } from './lifecycle-adapter'
import { FileLogService } from '../logging/file-log-service'
import { installConsoleFileLogging } from '../logging/console-bridge'
import { AppSettingsService } from '../app-settings/service'
import { CoreSettingsService } from '../kernel/core-settings-service'

/**
 * Electron shell bootstrap (Phase 1).
 *
 * Owns the module-level startup of the former monolithic `src/main/index.ts`:
 * boot-flag parsing, CI watchdogs, GPU suppression for headless probes, the
 * app-data pin, file logging and the storage warmup chain. The `app.whenReady`
 * orchestration lives in `when-ready.ts`; the packaged entry point
 * (`src/main/index.ts`) stays a thin loader.
 *
 * Bodies are extracted verbatim — every ordering guarantee below is
 * load-bearing and must not be reordered during the Tauri migration.
 */

export interface ShellBootstrap {
  readonly boot: BootFlags
  readonly state: ApplicationState
  readonly windowAdapter: WindowAdapter
  readonly lifecycle: LifecycleAdapter
  readonly fileLogs: FileLogService
  readonly appSettingsService: AppSettingsService
  readonly coreSettingsService: CoreSettingsService
  /** Resolves to the production/dev profile workspace root. */
  readonly storageWarmup: Promise<string>
  /** Warmed core settings read (chained on storageWarmup). */
  readonly coreSettingsWarm: Promise<Awaited<ReturnType<CoreSettingsService['getRaw']>>>
  /** Warmed app settings read (chained on storageWarmup). */
  readonly appSettingsWarm: Promise<Awaited<ReturnType<AppSettingsService['get']>>>
  /** Resolved log directory (`<userData>/logs`). */
  readonly logDirectory: string
  /** Stable app-data namespace root. */
  readonly appDataBaseRoot: string
}

export function bootstrapShell(): ShellBootstrap {
  // A single instance owns the protocol: a second launch forwards its deep link
  // to the running instance instead of opening a duplicate window.
  const hasSingleInstanceLock = app.requestSingleInstanceLock()
  if (!hasSingleInstanceLock) {
    app.quit()
  }

  const boot = parseBootFlags()
  // Diagnostics: dump the exact argv + boot flags the packaged process parsed, so
  // a CI spin shows ground truth about whether the probe flag survived delivery.
  writeBootDiagnostics(process.argv, boot, process.cwd())
  // CI-only loading-time watchdog for the interactive Windows smoke workflow (see
  // boot-flags.ts). Module-load arming fires no matter WHY startup stalls.
  armPackagingSmokeWatchdog(boot.hasArg)
  // The NSIS uninstaller waits synchronously for the headless restore command.
  armRestoreWatchdog(boot.hasArg)

  // Headless CI runners often have no GPU/display, and Electron can stall in
  // window-ready waiting on GPU init. For the CI probe modes (which never open a
  // GUI and exit fast) disable hardware acceleration so startup resolves; normal
  // user launches keep it.
  if (shouldDisableHardwareAcceleration(boot.hasArg)) {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
  }

  const state = createApplicationState(DEFAULT_APP_SETTINGS)
  // The lifecycle adapter is self-contained (it reads the shared state), so it
  // can be created before the window adapter and hand it the shutdown closure —
  // the close button and session-end start the SAME bounded flow as before-quit.
  const lifecycle = createLifecycleAdapter({
    state,
    flushLogs: async () => {
      await state.fileLogsRef?.writeApp('info', ['application shutdown completed'], 'shutdown').catch(() => undefined)
      await state.fileLogsRef?.flush()
    },
    waitForProfileOperations: async () => {
      await state.waitForProfileOperations?.()
    }
  })
  const windowAdapter = createWindowAdapter({
    state,
    isDevRuntime: () => is.dev,
    devRendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
    beginApplicationShutdown: lifecycle.beginApplicationShutdown,
    launchHidden: boot.launchHidden,
    isUiSmoke: boot.hasArg('--ui-smoke')
  })

  // Production pins the application-data directory to a stable, product-name-free
  // namespace (see storage/app-data.ts) so a future rename never orphans user
  // data. This must run before the ready event so every Electron subsystem that
  // derives paths from `userData` (localStorage, caches, session) resolves it
  // consistently. Dev builds leave the default path and the ephemeral profile
  // workspace untouched — dev builds never persist real user data.
  windowAdapter.pinAppData()
  const logDirectory = windowAdapter.setLogDirectory()
  const fileLogs = new FileLogService(logDirectory)
  state.fileLogsRef = fileLogs
  installConsoleFileLogging(fileLogs)
  void fileLogs.initialize()
    .then(() => fileLogs.writeApp('info', [
      `version=${app.getVersion()}`,
      `platform=${process.platform}`,
      `arch=${process.arch}`
    ], 'startup'))
    .catch(() => undefined)

  // Warm the durable-storage prerequisites while Electron finishes its own
  // ready-time initialization: the legacy-namespace migration and the profile
  // workspace must exist before any settings or profile read, so the chain
  // starts at module level and is awaited at first use inside whenReady. The two
  // settings services are constructed here for the same reason — their first
  // read overlaps ready-time work instead of extending the serial startup chain
  // ahead of window creation. Reads are chained on the warmup so a
  // product-rename migration can never be raced by an early settings read.
  const appDataBaseRoot = appDataRoot(app.getPath('appData'))
  const coreSettingsService = new CoreSettingsService(appDataBaseRoot)
  const appSettingsService = new AppSettingsService(appDataBaseRoot)
  const storageWarmup = (async (): Promise<string> => {
    // Import any data a prior build kept under the old product-name folder into
    // the stable namespace. Only runs in production (dev never writes real user
    // data) and is naturally idempotent.
    if (!is.dev) await migrateLegacyAppData(app.getPath('appData'))
    return resolveRuntimeProfileRoot(app.getPath('appData'), { dev: is.dev })
  })()
  const coreSettingsWarm = storageWarmup.then(() => coreSettingsService.getRaw())
  const appSettingsWarm = storageWarmup.then(() => appSettingsService.get())

  return {
    boot,
    state,
    windowAdapter,
    lifecycle,
    fileLogs,
    appSettingsService,
    coreSettingsService,
    storageWarmup,
    coreSettingsWarm,
    appSettingsWarm,
    logDirectory,
    appDataBaseRoot
  }
}
