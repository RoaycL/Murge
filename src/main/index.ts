import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { brand } from '@shared/brand'
import { parseBrandConfig } from '@shared/schemas/brand'
import { migrateLegacyAppData, appDataRoot, resolveRuntimeProfileRoot } from './storage/app-data'
import { registerIpc } from './ipc/register-ipc'
import { KernelSupervisor } from './kernel/supervisor'
import { createKernelResolver, MihomoKernelResolver } from './kernel/resolvers'
import { TempKernelConfigStore } from './kernel/config-store'
import { findFreePort, MihomoKernelConfigStore } from './kernel/mihomo-config-store'
import { randomSecret } from './kernel/mihomo-config'
import { ControllerReadyKernelGateway } from './kernel/controller-ready-gateway'
import { NodeKernelProcessAdapter } from './kernel/node-adapter'
import { MihomoClient } from './services/mihomo-client'
import { MihomoService } from './services/mihomo-service'
import { ProfileRepository } from './profiles/profile-repository'
import { ProfileService } from './profiles/profile-service'
import { createConfigValidator } from './profiles/config-validator'
import { SubscriptionFetcher } from './subscriptions/subscription-fetcher'
import { startMockMihomoServer, type MockMihomoServerHandle } from './testing/mock-mihomo-server'
import type { MihomoGateway } from '@shared/gateways'
import { ProtocolError, ProtocolErrorCode } from '../shared/protocol-errors'

const devControllerUrl = process.env.MURGE_DEV_CONTROLLER ?? 'http://127.0.0.1:9090'
const devControllerSecret = process.env.MURGE_DEV_SECRET ?? ''

// Production pins the application-data directory to a stable, product-name-free
// namespace (see storage/app-data.ts) so a future rename never orphans user
// data. This must run before the ready event so every Electron subsystem that
// derives paths from `userData` (localStorage, caches, session) resolves it
// consistently. Dev builds leave the default path and the ephemeral profile
// workspace untouched — see DEVELOPMENT_SAFETY.md.
if (!is.dev) {
  app.setPath('userData', appDataRoot(app.getPath('appData')))
}

// Created inside app.whenReady; held here so the quit path can stop it.
let kernel: KernelSupervisor | null = null
let mihomo: MihomoService | null = null
let mockServer: MockMihomoServerHandle | null = null
let disposeIpc: (() => void) | null = null
let isQuitting = false
// Keep a strong reference for the complete lifetime of the native window.
// A function-local BrowserWindow can be garbage-collected after createWindow
// returns, which is especially visible in packaged Windows builds as a running
// background process with no window.
let mainWindow: BrowserWindow | null = null

// Deep links (murge://...) that arrive before the window exists, or while a
// second instance hands its argv over, are queued here and flushed once the
// renderer is up. The Phase 7 milestone decides how the UI reacts; this phase
// only guarantees the registration and delivery plumbing never loses a link.
const pendingDeepLinks: string[] = []

function extractDeepLink(argv: string[]): string | null {
  const prefix = `${brand.protocolScheme}://`
  return argv.find((arg) => arg.startsWith(prefix)) ?? null
}

// A single instance owns the protocol: a second launch forwards its deep link
// to the running instance instead of opening a duplicate window.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

/**
 * Build the controller gateway. Development builds run the in-process localhost
 * mock controller so the renderer can be exercised without a real binary or any
 * network change. Production targets the randomized loopback controller used by
 * the opt-in safe-direct kernel lifecycle; no system-network setting is changed.
 */
async function createMihomoGateway(
  productionController?: { url: string; secret: string }
): Promise<MihomoGateway> {
  if (is.dev) {
    const secret = devControllerSecret || 'dev-mock-secret'
    mockServer = await startMockMihomoServer({ secret })
    const client = new MihomoClient(mockServer.baseUrl, secret)
    mihomo = new MihomoService(client, { wsBaseUrl: mockServer.wsBaseUrl, secret, enabled: true })
  } else {
    if (!productionController) {
      throw new ProtocolError(ProtocolErrorCode.INTERNAL, 'Production controller configuration is missing')
    }
    const client = new MihomoClient(productionController.url, productionController.secret)
    mihomo = new MihomoService(
      client,
      {
        wsBaseUrl: productionController.url.replace(/^http/, 'ws'),
        secret: productionController.secret,
        enabled: true
      }
    )
  }
  return mihomo
}

async function allocateProductionPorts(): Promise<{ controller: number; mixed: number }> {
  const controller = await findFreePort()
  let mixed = await findFreePort()
  // Port reservations are released before mihomo starts, so the OS may return
  // the same ephemeral port twice. Keep asking until both config fields differ.
  while (mixed === controller) mixed = await findFreePort()
  return { controller, mixed }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    // The approved Surge-derived reference is a 934 x 672 content viewport.
    // Keep the initial window on that exact canvas; users may still enlarge it.
    width: 934,
    height: 672,
    useContentSize: true,
    minWidth: 934,
    minHeight: 672,
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
  mainWindow = window

  // `ready-to-show` is an optimisation, not a visibility gate. Renderer load
  // failures and some Windows/GPU combinations may never emit it, so also show
  // after the document finishes loading. Both handlers are idempotent.
  const showWindow = (): void => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }
  window.once('ready-to-show', showWindow)
  window.webContents.once('did-finish-load', showWindow)
  if (process.argv.includes('--ui-smoke')) {
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
    if (mainWindow === window) mainWindow = null
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
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html')).catch((error) => {
      console.error('[window] failed to load packaged renderer:', error)
      showWindow()
    })
  }
  return window
}

/**
 * CI-only packaging probe. Runs a packaged production build with
 * `--packaging-smoke` and proves the storage wiring is functional without
 * touching the host's network stack: no window, no kernel, no socket is
 * created. It writes a sentinel into the stable profile root (so the Windows
 * smoke workflow can assert the profile survives an uninstall) and exits 0.
 */
async function runPackagingSmoke(profileRoot: string): Promise<void> {
  const sentinelPath = join(profileRoot, '.packaging-smoke-sentinel')
  await writeFile(
    sentinelPath,
    JSON.stringify({ mode: 'packaging-smoke', pid: process.pid, at: new Date().toISOString() }, null, 2) + '\n',
    'utf8'
  )
  const evidence = {
    mode: 'packaging-smoke',
    profileRoot,
    sentinel: sentinelPath,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch
  }
  // A single-line, stable marker leaves an audit trail in CI logs; it is not a
  // substitute for the portable assertion the smoke workflow performs.
  console.log(`[packaging-smoke] ${JSON.stringify(evidence)}`)
  app.exit(0)
}

app.whenReady().then(async () => {
  try {
    parseBrandConfig(brand)
  } catch (error) {
    console.error('[brand] invalid brand configuration:', error)
    app.exit(1)
    return
  }

  app.setName(brand.productName)

  // Register the murge:// handler with the OS. The electron-builder `protocols`
  // entry only covers macOS/Linux — the NSIS target writes no registry keys, so
  // Windows relies on this runtime registration (HKCU, per-user, no elevation).
  if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient(brand.protocolScheme)
  }

  // A second instance launched via a deep link hands its argv over here.
  app.on('second-instance', (_event, argv) => {
    const link = extractDeepLink(argv)
    if (link) pendingDeepLinks.push(link)
    const window = mainWindow ?? BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  // Import any data a prior build kept under the old product-name folder into
  // the stable namespace. Only runs in production (dev never writes real user
  // data) and is naturally idempotent.
  if (!is.dev) {
    await migrateLegacyAppData(app.getPath('appData'))
  }

  // A deep link that launched this instance arrives in the initial argv.
  const launchLink = extractDeepLink(process.argv)
  if (launchLink) pendingDeepLinks.push(launchLink)

  // Resolve the profile workspace for this build. Development keeps an ephemeral
  // temp dir (never touches real user data); production persists to a stable,
  // product-name-free namespace. We pass the *platform* app-data root, not the
  // already-pinned `userData`, so the namespace is not doubled.
  const profileRoot = await resolveRuntimeProfileRoot(app.getPath('appData'), { dev: is.dev })

  // CI-only startup probe (see the `package-win` workflow). Verifies production
  // storage wiring and that packaging did not break the launch path, without
  // opening a window, starting a kernel, or binding any socket.
  if (process.argv.includes('--packaging-smoke')) {
    await runPackagingSmoke(profileRoot)
    return
  }

  // Development always uses the harmless fixture process. A packaged Windows
  // build is composed with the verified real resolver, but KernelSupervisor is
  // lazy: resolve/download/spawn happen only after the renderer invokes
  // `kernel:start`. Non-Windows production builds remain fail-closed.
  const productionSecret = is.dev ? null : randomSecret(32)
  const productionPorts = is.dev ? null : await allocateProductionPorts()
  const productionControllerPort = productionPorts?.controller ?? null
  const productionMixedPort = productionPorts?.mixed ?? null
  const productionKernelRoot = join(profileRoot, 'kernel')
  const kernelInstance = new KernelSupervisor(
    {
      resolver: is.dev
        ? createKernelResolver({ appPath: app.getAppPath(), mode: 'fixture' })
        : process.platform === 'win32'
          ? new MihomoKernelResolver({ allowReal: true, workspaceDir: productionKernelRoot })
          : createKernelResolver({ appPath: app.getAppPath(), mode: 'disabled' }),
      configStore: is.dev
        ? new TempKernelConfigStore()
        : new MihomoKernelConfigStore({
            mixedPort: productionMixedPort!,
            controllerPort: productionControllerPort!,
            workspaceDir: join(productionKernelRoot, 'runtime')
          }),
      adapter: new NodeKernelProcessAdapter(),
      secret: is.dev ? devControllerSecret : productionSecret!
    },
    { readinessPattern: is.dev ? /fixture-ready/ : null }
  )
  kernel = kernelInstance
  // Await the (mock or disabled) controller gateway before wiring IPC so the
  // renderer's first pull always sees a live controller in dev.
  const gateway = await createMihomoGateway(
    is.dev
      ? undefined
      : {
          url: `http://127.0.0.1:${productionControllerPort}`,
          secret: productionSecret!
        }
  )
  const ipcKernel = !is.dev && mihomo
    ? new ControllerReadyKernelGateway(
        kernelInstance,
        new MihomoClient(`http://127.0.0.1:${productionControllerPort}`, productionSecret!, { timeoutMs: 750 })
      )
    : kernelInstance
  const validator = createConfigValidator({ requireProxySections: false })
  
  // SECURITY: In development builds, block all outbound network requests for subscriptions
  // to comply with DEVELOPMENT_SAFETY.md restrictions. Production builds use real fetch.
  let subscriptionFetcher: SubscriptionFetcher
  if (is.dev) {
    subscriptionFetcher = new SubscriptionFetcher({
      strictUrlValidation: true,
      fetchFn: async () => {
        throw new ProtocolError(
          ProtocolErrorCode.INVALID_ARGUMENT,
          '开发构建禁止真实订阅抓取；请切换到生产构建或显式启用网络访问'
        )
      }
    })
  } else {
    subscriptionFetcher = new SubscriptionFetcher()
  }
  
  const profileService = new ProfileService(
    new ProfileRepository({ rootDir: profileRoot, validator }),
    validator,
    subscriptionFetcher
  )
  disposeIpc = registerIpc({
    kernel: ipcKernel,
    mihomo: gateway,
    profiles: profileService
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
  console.error('[startup] fatal initialization failure:', error)
  // Packaged GUI applications normally have no attached console. Surface the
  // failure instead of leaving an invisible background process behind.
  dialog.showErrorBox(`${brand.productName} failed to start`, message)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Give the kernel a bounded chance to shut down and release its temp config
// before the process exits. Without this the child could outlive the GUI and
// keep a port (and a secret-bearing temp dir) behind. The guard flag makes the
// flow idempotent: block the first quit, stop the kernel, then really quit.
app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  void (async () => {
    try {
      await kernel?.stop()
    } catch (error) {
      console.error('[kernel] failed to stop during quit:', error)
    }
    try {
      disposeIpc?.()
      mihomo?.dispose()
      await mockServer?.close()
    } catch (error) {
      console.error('[mihomo] failed to stop mock controller during quit:', error)
    } finally {
      disposeIpc = null
    }
    app.quit()
  })()
})
