import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { brand } from '@shared/brand'
import { IPC } from '@shared/ipc'
import { appDataRoot } from '../storage/app-data'
import type { ApplicationState } from './runtime-state'
import { createDeepLinkQueue, type DeepLinkQueue } from './deep-link'

/**
 * Window & identity adapter: everything in the Electron shell that shapes the
 * BrowserWindow, pins the app-data namespace, registers the deep-link protocol
 * and routes second instances / notification navigation. Extracted verbatim
 * from the former monolithic `src/main/index.ts` (Phase 1 boundary), so every
 * constant, guard and ordering guarantee below matches the pre-refactor shell.
 */
export interface WindowAdapterOptions {
  state: ApplicationState
  /** Resolves true when running under the electron-vite dev server. */
  isDevRuntime: () => boolean
  /** Dev renderer URL (ELECTRON_RENDERER_URL) or null in packaged builds. */
  devRendererUrl: string | null
  /** Full shutdown flow (close-button path). */
  beginApplicationShutdown: (sessionEnding: boolean) => Promise<void>
  /** Login-item silent launch: the window must not be shown. */
  launchHidden: boolean
  /** CI-only preload bridge probe. */
  isUiSmoke: boolean
}

/** The approved Surge-derived reference viewport, kept byte-identical. */
export const WINDOW_GEOMETRY = {
  width: 934,
  height: 672,
  useContentSize: true,
  minWidth: 848,
  minHeight: 640,
} as const

// Deep-link extraction/queueing lives in its own Electron-free module so the
// Phase 1 boundary keeps registration/delivery logic unit-testable.
export { extractDeepLink, createDeepLinkQueue, type DeepLinkQueue } from './deep-link'

export interface WindowAdapter {
  /** Create and track the main BrowserWindow (verbatim createWindow body). */
  createWindow(): BrowserWindow
  /** Pin userData to the stable namespace BEFORE the ready event. */
  pinAppData(): void
  /** Point app logs at `<userData>/logs` and return that directory. */
  setLogDirectory(): string
  /** Register the murge:// handler + AppUserModelId (Windows, HKCU). */
  registerIdentity(): void
  /** Handle a second instance: queue deep link, reveal main window. */
  onSecondInstance(argv: readonly string[]): void
  /** Queue a deep link found in the initial argv. Returns the link when found. */
  queueLaunchDeepLink(argv: readonly string[]): string | null
  /** Reveal the window and deliver a trusted internal route (notification). */
  showMainWindowAt(route: '/about'): void
  /** Reveal (and focus) the main window, recreating it if needed. */
  showMainWindow(): void
  /** The deep-link queue created for this process. */
  readonly deepLinks: DeepLinkQueue
}

export function createWindowAdapter(options: WindowAdapterOptions): WindowAdapter {
  const { state } = options
  const deepLinks = createDeepLinkQueue()

  function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      // The approved Surge-derived reference remains a 934 x 672 content
      // viewport, so the window still opens on that exact canvas. The layout is
      // fluid: users may enlarge *or shrink* the window, but only down to the
      // point where the Activity dashboard's cards reach their minimum width —
      // each grid column bottoms out at 280px (the shared --card-min token), so
      // the grid needs 2*280+15=575px. The corrected Surge geometry uses three
      // ~2.1:1 rows on the left and one square spanning the lower two rows, so it
      // fits the reference-height canvas without vertical clipping:
      //   minWidth  = 575 (grid) + 68 (page-shell L/R padding) + 205 (sidebar)
      //   minHeight = 640 (keeps the complete dashboard usable at minimum width)
      ...WINDOW_GEOMETRY,
      // Surge places its content beneath the traffic-light/title-bar region.
      // The renderer already owns a draggable strip; keep native window controls
      // as an overlay on Windows while avoiding a second 30px layout offset.
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#858b95',
        height: 34
      },
      show: false,
      autoHideMenuBar: true,
      title: brand.productName,
      backgroundColor: '#eef3f8',
      webPreferences: {
        // Keep this aligned with electron.vite.config.ts. Sandboxed Electron
        // preloads must use the CommonJS-compatible output; an ESM .mjs preload
        // leaves `window.desktop` undefined and every IPC-backed view stuck.
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    state.mainWindow = window

    // Closing the window keeps the explicitly visible tray application alive.
    // A real app quit (tray menu / OS shutdown) passes through before-quit and is
    // never intercepted here, so proxy + kernel recovery ordering remains intact.
    window.on('close', (event) => {
      if (state.isQuitting) return
      event.preventDefault()
      // Close-to-tray (verge's 最小化到托盘而非退出): the tray application stays
      // alive. With the preference off, the close button quits through the SAME
      // bounded restore-and-shutdown flow as the tray menu, so an owned system
      // proxy is always restored before the process exits.
      if (state.cachedAppSettings.closeToTray) {
        window.hide()
        return
      }
      void options.beginApplicationShutdown(false)
    })
    // Windows does not guarantee Electron's application-level before-quit event
    // during logoff/restart/shutdown. Start the same bounded network cleanup from
    // the native window session-end notification as a best-effort head start.
    if (process.platform === 'win32') {
      window.on('session-end', () => {
        void options.beginApplicationShutdown(true)
      })
    }

    // `ready-to-show` is an optimisation, not a visibility gate. Renderer load
    // failures and some Windows/GPU combinations may never emit it, so also show
    // after the document finishes loading. Both handlers are idempotent.
    const showWindow = (): void => {
      if (options.launchHidden) return
      if (!window.isDestroyed() && !window.isVisible()) window.show()
    }
    window.once('ready-to-show', showWindow)
    window.webContents.once('did-finish-load', showWindow)
    if (options.isUiSmoke) {
      window.webContents.once('did-finish-load', () => {
        void window.webContents.executeJavaScript(
          `window.desktop.app.getBrand().then((value) => ({ productName: value.productName, hasMihomo: typeof window.desktop.mihomo?.getConnections === 'function' }))`
        ).then((result: { productName?: string; hasMihomo?: boolean }) => {
          if (result.productName !== brand.productName || result.hasMihomo !== true) {
            throw new Error('preload API did not expose the expected typed desktop bridge')
          }
          console.log(`[ui-smoke] preload IPC ready for ${result.productName}`)
          app.exit(0)
        }).catch((error) => {
          console.error('[ui-smoke] preload IPC failed:', error)
          app.exit(1)
        })
      })
    }
    window.on('closed', () => {
      if (state.mainWindow === window) state.mainWindow = null
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('[window] renderer process exited:', details.reason, details.exitCode)
    })
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return
      console.error(`[window] failed to load ${url}: ${code} ${description}`)
      showWindow()
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      const allowed = new Set([brand.repositoryUrl, brand.supportUrl].filter(Boolean))
      if (allowed.has(url) && url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    if (options.isDevRuntime() && options.devRendererUrl) {
      void window.loadURL(options.devRendererUrl)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html')).catch((error) => {
        console.error('[window] failed to load packaged renderer:', error)
        showWindow()
      })
    }
    return window
  }

  function pinAppData(): void {
    // Production pins the application-data directory to a stable, product-name-free
    // namespace (see storage/app-data.ts) so a future rename never orphans user
    // data. This must run before the ready event so every Electron subsystem that
    // derives paths from `userData` (localStorage, caches, session) resolves it
    // consistently. Dev builds leave the default path and the ephemeral profile
    // workspace untouched — dev builds never persist real user data.
    if (!options.isDevRuntime()) {
      app.setPath('userData', appDataRoot(app.getPath('appData')))
    }
  }

  function setLogDirectory(): string {
    const logDirectory = join(app.getPath('userData'), 'logs')
    app.setAppLogsPath(logDirectory)
    return logDirectory
  }

  function registerIdentity(): void {
    // Register the murge:// handler with the OS. The electron-builder `protocols`
    // entry only covers macOS/Linux — the NSIS target writes no registry keys, so
    // Windows relies on this runtime registration (HKCU, per-user, no elevation).
    if (process.platform === 'win32') {
      // Keep taskbar grouping, shortcuts and the Electron Run-key fallback on
      // the same brand-stable identity. This also makes future cleanup independent
      // of the package/product display name.
      app.setAppUserModelId(brand.appId)
      app.setAsDefaultProtocolClient(brand.protocolScheme)
    }
  }

  function onSecondInstance(argv: readonly string[]): void {
    deepLinks.pushFromArgv(argv)
    const window = state.mainWindow ?? BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  }

  function queueLaunchDeepLink(argv: readonly string[]): string | null {
    return deepLinks.pushFromArgv(argv)
  }

  function showMainWindowAt(route: '/about'): void {
    state.pendingRendererRoute = route
    const window = state.mainWindow ?? BrowserWindow.getAllWindows()[0] ?? createWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const deliver = (): void => {
      if (window.isDestroyed() || !state.pendingRendererRoute) return
      window.webContents.send(IPC.appNavigateEvent, state.pendingRendererRoute)
      state.pendingRendererRoute = null
    }
    if (window.webContents.isLoadingMainFrame()) {
      window.webContents.once('did-finish-load', deliver)
    } else {
      deliver()
    }
  }

  function showMainWindow(): void {
    const window = state.mainWindow ?? BrowserWindow.getAllWindows()[0] ?? createWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  return {
    createWindow,
    pinAppData,
    setLogDirectory,
    registerIdentity,
    onSecondInstance,
    queueLaunchDeepLink,
    showMainWindowAt,
    showMainWindow,
    deepLinks
  }
}
