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
import { createSystemProxy } from './system-proxy/factory'
import { SystemProxyService } from './system-proxy/service'
import { WindowsSystemProxyAdapter } from './system-proxy/adapters/windows-adapter'
import { DisabledSystemProxyAdapter } from './system-proxy/adapters/disabled-adapter'
import { FileSystemProxyBackupStore } from './system-proxy/backup-store'
import { StaticSystemProxyProbe, LiveSystemProxyKernelProbe, type LiveProbeMihomo } from './system-proxy/probe'
import type { KernelGateway } from '../shared/gateways'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '../shared/system-proxy'
import { SystemProxyOrderedKernelGateway } from './system-proxy/ordered-kernel-gateway'
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
import { runQuitFlow } from './quit-guard'
import { TrayController } from './tray/tray-controller'
import { createElectronTray } from './tray/electron-tray'
import { StartupService } from './startup/service'
import { ElectronStartupAdapter } from './startup/electron-adapter'
import { TunCoordinator, GatedTunMutationAdapter } from './tun/coordinator'
import { MihomoOwnedTunAdapter } from './tun/mihomo-owned-adapter'
import { TunServiceClient } from './tun/service-client'
import { NamedPipeTunServiceTransport } from './tun/named-pipe-transport'
import { tunServiceIdentity } from './tun/service-identity'
import type { TunGateway, TunStatus } from '../shared/tun'

const devControllerUrl = process.env.MURGE_DEV_CONTROLLER ?? 'http://127.0.0.1:9090'
const devControllerSecret = process.env.MURGE_DEV_SECRET ?? ''
const launchHidden = process.argv.includes('--hidden')

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
let systemProxy: SystemProxyService | null = null
let mockServer: MockMihomoServerHandle | null = null
let disposeIpc: (() => void) | null = null
let isQuitting = false
// Keep a strong reference for the complete lifetime of the native window.
// A function-local BrowserWindow can be garbage-collected after createWindow
// returns, which is especially visible in packaged Windows builds as a running
// background process with no window.
let mainWindow: BrowserWindow | null = null
let trayController: TrayController | null = null
let tunCoordinator: TunCoordinator | null = null

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

  // Closing the window keeps the explicitly visible tray application alive.
  // A real app quit (tray menu / OS shutdown) passes through before-quit and is
  // never intercepted here, so proxy + kernel recovery ordering remains intact.
  window.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    window.hide()
  })

  // `ready-to-show` is an optimisation, not a visibility gate. Renderer load
  // failures and some Windows/GPU combinations may never emit it, so also show
  // after the document finishes loading. Both handlers are idempotent.
  const showWindow = (): void => {
    if (launchHidden) return
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
    const allowed = new Set([brand.repositoryUrl, brand.supportUrl].filter(Boolean))
    if (allowed.has(url) && url.startsWith('https://')) void shell.openExternal(url)
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

/**
 * CI / NSIS-uninstall shutdown hook. Runs the system-proxy restore in a headless
 * process: no window, no kernel, no socket. It reads the brand-independent
 * owned backup from app-data and restores the exact pre-enable registry values
 * (with the precise type preserved), deleting the backup only on a confirmed
 * restore. A conflict is reported without overwriting; a corrupted backup fails
 * closed without ever entering the restore-write path.
 */
async function runSystemProxyRestore(): Promise<void> {
  const backupStore = FileSystemProxyBackupStore.forAppDataBase(app.getPath('appData'))
  const service = new SystemProxyService({
    adapter:
      process.platform === 'win32'
        ? new WindowsSystemProxyAdapter()
        : new DisabledSystemProxyAdapter(process.platform),
    probe: new StaticSystemProxyProbe({ host: SYSTEM_PROXY_LOOPBACK_HOST, port: 1 }),
    backup: backupStore,
    instanceId: 'restore-cli'
  })
  try {
    const status = await service.init()
    // `disabled` = restored (or nothing owned); `conflict` = the registry no longer
    // matches the written state, so we intentionally did NOT overwrite.
    let ok = status.phase === 'disabled'
    if (status.phase === 'conflict') {
      // The uninstaller aborts on a non-zero restore exit *only* when the owned
      // proxy could not be put back. `init()` collapses both an external-edit
      // conflict (safe — leave the registry untouched) and a corrupt / unreadable
      // backup into `conflict`, so re-read the backup to tell them apart: a backup
      // that still parses is an external edit (continue the uninstall, exit 0); a
      // backup that no longer reads is corrupt and restore has to fail (exit 1).
      try {
        await backupStore.read()
        // A parseable bundle (or none at all) means the registry was simply edited
        // externally; safe to continue.
        ok = true
      } catch {
        ok = false
      }
    }
    console.log(
      `[restore-system-proxy] ${JSON.stringify({
        phase: status.phase,
        ok,
        errorMessage: status.errorMessage ?? null,
        conflictDetail: status.conflictDetail ?? null
      })}`
    )
    app.exit(ok ? 0 : 1)
  } catch (error) {
    console.error('[restore-system-proxy] FAILED:', error)
    app.exit(1)
  }
}

/**
 * CI-only installed-artifact probe: start the bundled kernel, read the *live*
 * mixed-port, socket-prove it (TCP / HTTP CONNECT / SOCKS5), then enable the
 * per-user HKCU system proxy headlessly (writes the owned app-data backup) and
 * exit. Used by the `package-win` job to prove the install -> enable -> uninstall
 * -> exact-restore path.
 *
 * This is intentionally gated behind a CI marker so a packaged Windows build can
 * never let an arbitrary user manufacture a dead-proxy registry state: the probe
 * refuses to run unless BOTH `MURGE_CI_SYSTEM_PROXY_ENABLE=1` and the GitHub
 * Actions runner (enabled + uninstallable) are set. The kernel is started and
 * stopped here; only the proxy registry state (and the owned backup) are left
 * behind for the uninstaller / external recovery helper to restore.
 */
async function runSystemProxyEnable(
  kernel: KernelGateway,
  mihomo: LiveProbeMihomo
): Promise<void> {
  if (process.env.MURGE_CI_SYSTEM_PROXY_ENABLE !== '1' || process.env.GITHUB_ACTIONS !== 'true') {
    console.error('[system-proxy-enable] refused: not a gated CI run (GITHUB_ACTIONS/MURGE_CI_SYSTEM_PROXY_ENABLE)')
    app.exit(1)
    return
  }
  const service = new SystemProxyService({
    adapter:
      process.platform === 'win32'
        ? new WindowsSystemProxyAdapter()
        : new DisabledSystemProxyAdapter(process.platform),
    probe: new LiveSystemProxyKernelProbe(kernel, mihomo),
    backup: FileSystemProxyBackupStore.forAppDataBase(app.getPath('appData')),
    instanceId: 'enable-cli'
  })
  try {
    const started = await kernel.start()
    if (started.phase !== 'running') {
      throw new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, 'Kernel did not reach running state to enable the system proxy')
    }
    const status = await service.enable()
    // `enabled` = the proxy is now owned by us; `conflict` = the registry already
    // held a different value (idempotent/owned), so we did not overwrite.
    const ok = status.phase === 'enabled' || status.phase === 'conflict'
    console.log(
      `[system-proxy-enable] ${JSON.stringify({
        phase: status.phase,
        ok,
        address: status.address ?? null,
        port: status.port ?? null,
        errorMessage: status.errorMessage ?? null,
        conflictDetail: status.conflictDetail ?? null
      })}`
    )
    // Stop the kernel before exiting so no mihomo child lingers and the proxy is
    // left pointing at a now-dead loopback port — the orphan only the uninstaller
    // / recovery helper must undo. Restore runs standalone and does not need it.
    await kernel.stop().catch(() => undefined)
    app.exit(ok ? 0 : 1)
  } catch (error) {
    console.error('[system-proxy-enable] FAILED:', error)
    await kernel.stop().catch(() => undefined)
    app.exit(1)
  }
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
      window.show()
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

  // Profile/subscription service, created BEFORE the kernel so the kernel config
  // store can resolve the ACTIVE profile's document and run the user's
  // proxies / proxy-groups / rules instead of the strict direct-only bootstrap.
  // This is what makes the Policy and Rules views reflect the imported profile.
  const validator = createConfigValidator({ requireProxySections: false })

  // SECURITY: In development builds, block all outbound network requests for subscriptions
  // to comply with DEVELOPMENT_SAFETY.md restrictions. Production builds use real fetch.
  const subscriptionFetcher = is.dev
    ? new SubscriptionFetcher({
        strictUrlValidation: true,
        fetchFn: async () => {
          throw new ProtocolError(
            ProtocolErrorCode.INVALID_ARGUMENT,
            '开发构建禁止真实订阅抓取；请切换到生产构建或显式启用网络访问'
          )
        }
      })
    : new SubscriptionFetcher()

  const profileService = new ProfileService(
    new ProfileRepository({ rootDir: profileRoot, validator }),
    validator,
    subscriptionFetcher
  )

  // CI-only startup probe (see the `package-win` workflow). Verifies production
  // storage wiring and that packaging did not break the launch path, without
  // opening a window, starting a kernel, or binding any socket.
  if (process.argv.includes('--packaging-smoke')) {
    await runPackagingSmoke(profileRoot)
    return
  }

  // Headless system-proxy restore (see runSystemProxyRestore). Used by the
  // uninstaller and CI whenever the GUI must not be started.
  if (process.argv.includes('--restore-system-proxy')) {
    await runSystemProxyRestore()
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
          ? new MihomoKernelResolver({
              allowReal: true,
              workspaceDir: productionKernelRoot,
              bundledArchiveDir: join(process.resourcesPath, 'bin')
            })
          : createKernelResolver({ appPath: app.getAppPath(), mode: 'disabled' }),
      configStore: is.dev
        ? new TempKernelConfigStore()
        : new MihomoKernelConfigStore({
            mixedPort: productionMixedPort!,
            controllerPort: productionControllerPort!,
            workspaceDir: join(productionKernelRoot, 'runtime'),
            // Drive the live controller from the ACTIVE profile (proxies, groups,
            // rules, providers) instead of the strict direct-only bootstrap. Falls
            // back to the strict config when no profile is active (e.g. CI smoke).
            resolveActiveDocument: async () =>
              (await profileService.getActiveProfile())?.document ?? null
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

  // CI-only installed-artifact probe. Unlike --packaging-smoke, this exercises
  // the complete opt-in production path: bundled archive verification,
  // extraction, process spawn, authenticated /version readiness and cleanup.
  // The generated config is loopback-only/direct with TUN and DNS disabled.
  if (!is.dev && process.argv.includes('--kernel-smoke')) {
    const started = await ipcKernel.start()
    if (started.phase !== 'running') {
      throw new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, 'Packaged kernel did not reach running state')
    }
    await ipcKernel.stop()
    console.log('[kernel-smoke] bundled kernel lifecycle: PASS')
    app.quit()
    return
  }

  // CI-only installed-artifact probe: enable the per-user HKCU system proxy
  // headlessly so the `package-win` job can drive the install -> enable ->
  // uninstall -> restore path. Never runs in dev so a developer cannot
  // accidentally mutate the real registry, and it is further gated on the GitHub
  // Actions CI marker inside runSystemProxyEnable so a packaged Windows build
  // can never be used by an arbitrary user to manufacture a dead-proxy state.
  // Because the live probe needs a running kernel, this is handled AFTER the
  // kernel + gateway are wired (the probe reads the real mixed-port and proves it
  // with a TCP / HTTP / SOCKS socket check before the registry is touched).
  if (!is.dev && process.argv.includes('--system-proxy-enable')) {
    await runSystemProxyEnable(ipcKernel, gateway)
    return
  }

  // System-proxy controller. The probe reads the *live* mixed-port from the
  // controller (never a hard-coded value); the backup store lives in the stable
  // brand-independent app-data namespace so a crash mid-apply is recoverable.
  // `init()` restores any orphan from a previous crash before the UI is usable.
  const systemProxyService = createSystemProxy({
    appDataBase: app.getPath('appData'),
    isDev: is.dev,
    kernel: ipcKernel,
    mihomo: gateway
  })
  systemProxy = systemProxyService
  await systemProxyService.init()

  // Order the proxy restore ahead of kernel shutdown: a user stop restores the
  // system proxy first and aborts the stop if that restoration genuinely fails,
  // so the proxy never points at a dead port.
  const orderedKernel = new SystemProxyOrderedKernelGateway(ipcKernel, systemProxyService)

  // Crash the controller while the proxy was owned: the port is now dead, so
  // restore the proxy immediately (conflict is safe — the proxy is not ours —
  // while a real restore failure stays visible as `restore-failed`).
  orderedKernel.onStatus((status) => {
    if (status.phase !== 'failed') return
    void systemProxyService.restoreBeforeKernelUnavailable().catch((error) => {
      console.error('[system-proxy] kernel crash recovery failed:', error)
    })
  })

  const tunSupported = !is.dev && process.platform === 'win32'
  const tunAdapter = tunSupported
    ? new MihomoOwnedTunAdapter(
        new TunServiceClient(
          new NamedPipeTunServiceTransport(tunServiceIdentity(brand.appId).pipeName)
        ),
        async () => {
          const controllerPort = await findFreePort()
          let mixedPort = await findFreePort()
          while (mixedPort === controllerPort) mixedPort = await findFreePort()
          return { controllerPort, mixedPort, secret: randomSecret(32) }
        },
        {
          waitUntilReady: async ({ controllerPort, secret, signal }) => {
            const client = new MihomoClient(`http://127.0.0.1:${controllerPort}`, secret, { timeoutMs: 500 })
            while (!signal.aborted) {
              try {
                await client.getVersion(signal)
                return
              } catch {
                if (signal.aborted) break
                await new Promise<void>((resolve) => setTimeout(resolve, 100))
              }
            }
            throw new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, 'TUN controller readiness timed out')
          }
        }
      )
    : new GatedTunMutationAdapter()
  const tunInstance = new TunCoordinator(tunAdapter, tunSupported)
  tunCoordinator = tunInstance
  if (tunSupported) {
    await tunInstance.initialize().catch((error) => {
      console.error('[tun] service reconciliation failed:', error)
    })
  }
  const tunGateway: TunGateway = {
    getStatus: () => tunInstance.getStatus(),
    enable: () => tunInstance.enable({
      schemaVersion: 2,
      device: `${brand.shortName} TUN`,
      stack: 'mixed'
    }),
    disable: () => tunInstance.emergencyDisable(),
    onStatus: (listener) => tunInstance.onStatus(listener)
  }
  disposeIpc = registerIpc({
    kernel: orderedKernel,
    mihomo: gateway,
    profiles: profileService,
    systemProxy: systemProxyService,
    startup: new StartupService(new ElectronStartupAdapter()),
    tun: tunGateway
  })
  createWindow()
  const showMainWindow = (): void => {
    const window = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? createWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  const trayIcon = is.dev
    ? join(app.getAppPath(), 'resources', 'icon.png')
    : join(process.resourcesPath, 'icon.png')
  trayController = new TrayController({
    productName: brand.productName,
    kernel: orderedKernel,
    view: createElectronTray(trayIcon),
    showWindow: showMainWindow,
    quit: () => app.quit(),
    onError: (error) => console.error('[tray] kernel action failed:', error)
  })
  await trayController.initialize()

  // CI-only installed-artifact proof for the real login-launch shape. It
  // creates the hidden BrowserWindow and native Tray, but never starts mihomo
  // or mutates proxy/TUN/DNS.
  if (!is.dev && process.argv.includes('--hidden-smoke')) {
    if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.MURGE_CI_HIDDEN_START !== '1') {
      throw new Error('--hidden-smoke is restricted to the packaged GitHub Actions Windows probe')
    }
    const window = mainWindow
    const status = await orderedKernel.getStatus()
    if (!launchHidden || !window || window.isDestroyed() || window.isVisible()) {
      throw new Error('hidden startup created a missing, destroyed, or visible main window')
    }
    if (!trayController.isReady()) throw new Error('hidden startup did not create a live native tray')
    if (status.phase !== 'stopped' || status.pid !== null) {
      throw new Error(`hidden startup unexpectedly activated the kernel (${status.phase}, pid=${status.pid ?? 'none'})`)
    }
    console.log('[hidden-smoke] hidden window + native tray + stopped kernel: PASS')
    app.exit(0)
    return
  }

  app.on('activate', () => {
    showMainWindow()
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
async function restoreSystemProxyBeforeQuit(): Promise<boolean> {
  if (!systemProxy) return true
  for (let attempt = 1; attempt <= MAX_QUIT_RESTORE_ATTEMPTS; attempt++) {
    try {
      await systemProxy.restoreBeforeKernelUnavailable()
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

async function restoreNetworkBeforeQuit(): Promise<boolean> {
  if (tunCoordinator) {
    try {
      const status: TunStatus = await tunCoordinator.emergencyDisable()
      if (status.phase !== 'configured' && status.phase !== 'unsupported') {
        console.error('[tun] refused quit because TUN stop was not confirmed:', status)
        return false
      }
    } catch (error) {
      console.error('[tun] restore during quit failed:', error)
      return false
    }
  }
  return restoreSystemProxyBeforeQuit()
}

app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  void (async () => {
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
        await kernel?.stop()
      },
      dispose: async () => {
        try {
          trayController?.dispose()
          disposeIpc?.()
          mihomo?.dispose()
          await mockServer?.close()
        } catch (error) {
          console.error('[mihomo] failed to stop mock controller during quit:', error)
        } finally {
          trayController = null
          disposeIpc = null
        }
      },
      quit: () => app.quit(),
      onCleanupError: (error, step) => console.error(`[quit-guard] ${step} failed during quit:`, error)
    })
    if (result === 'restore-failed') {
      isQuitting = false
      const window = mainWindow ?? BrowserWindow.getAllWindows()[0]
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
      return
    }
  })()
})
