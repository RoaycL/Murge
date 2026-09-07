import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { attachKernelWatchdog } from './kernel/crash-watchdog'
import { InternetLatencyService } from './services/internet-latency-service'
import { app, BrowserWindow, dialog, nativeTheme, powerMonitor, safeStorage, shell } from 'electron'
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
import { LateBoundKernelGateway } from './kernel/single-kernel-gateway'
import { PrivilegedServiceKernelGateway } from './kernel/privileged-service-gateway'
import { createSystemProxy } from './system-proxy/factory'
import { SystemProxyService } from './system-proxy/service'
import { WindowsSystemProxyAdapter } from './system-proxy/adapters/windows-adapter'
import { DisabledSystemProxyAdapter } from './system-proxy/adapters/disabled-adapter'
import { FileSystemProxyBackupStore } from './system-proxy/backup-store'
import { StaticSystemProxyProbe, LiveSystemProxyKernelProbe, type LiveProbeMihomo } from './system-proxy/probe'
import type { KernelGateway } from '../shared/gateways'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '../shared/system-proxy'
import { SystemProxyOrderedKernelGateway } from './system-proxy/ordered-kernel-gateway'
import { NetworkDetector } from './services/network-detector'
import { NodeKernelProcessAdapter } from './kernel/node-adapter'
import { MihomoClient } from './services/mihomo-client'
import { MihomoService } from './services/mihomo-service'
import { UsageHistoryService } from './services/usage-history-service'
import { FileSystemUsageHistoryStore, InMemoryUsageHistoryStore } from './services/usage-history-store'
import { NetworkMetadataService, fetchMetadataJsonViaProxy } from './services/network-metadata-service'
import { ProfileRepository } from './profiles/profile-repository'
import { EncryptedProfileSourceStore } from './profiles/profile-source-store'
import { ProfileService } from './profiles/profile-service'
import { ProfileAutoReloadGateway } from './profiles/profile-auto-reload-gateway'
import { parseProxyGroupOrder, parseProxyGroupTestUrls } from './profiles/proxy-group-order'
import { parseProviderCatalog } from './profiles/provider-configs'
import { ServiceUnlockService } from './services/service-unlock-service'
import { ProxySelectionStore } from './profiles/proxy-selection-store'
import { ProxySelectionService } from './services/proxy-selection-service'
import { ProxySelectionGateway } from './services/proxy-selection-gateway'
import { createConfigValidator } from './profiles/config-validator'
import { reloadKernelForActiveProfile } from './system-proxy/reload-kernel'
import { SubscriptionFetcher } from './subscriptions/subscription-fetcher'
import { createSubscriptionProxyFetchFn } from './subscriptions/proxy-fetch-transport'
import { startMockMihomoServer, type MockMihomoServerHandle } from './testing/mock-mihomo-server'
import type { MihomoGateway } from '@shared/gateways'
import { ProtocolError, ProtocolErrorCode } from '../shared/protocol-errors'
import { KernelManagerService } from './kernel/kernel-manager-service'
import { runQuitFlow } from './quit-guard'
import { TrayController } from './tray/tray-controller'
import { createElectronTray } from './tray/electron-tray'
import { resolveRuntimeAccent } from '@shared/runtime-accent'
import { StartupService } from './startup/service'
import { ElectronStartupAdapter } from './startup/electron-adapter'
import { restoreRuntimeIntent } from './startup/runtime-intent'
import { RuntimeIntentRecoveryCoordinator } from './startup/runtime-intent-recovery'
import { AppSettingsService } from './app-settings/service'
import { SubStoreService } from './substore/service'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/app-settings'
import { OverrideService } from './kernel/overrides/override-service'
import { DnsEnhancementService } from './kernel/dns/dns-enhancement-service'
import { documentDnsEnabled } from './kernel/dns/apply-dns'
import { SnifferEnhancementService } from './kernel/sniffer/sniffer-enhancement-service'
import { CoreSettingsService } from './kernel/core-settings-service'
import { GeodataSettingsService } from './kernel/geodata-settings-service'
import { UpdateService } from './updates/service'
import { ElectronUpdaterDriver } from './updates/electron-updater-driver'
import { TunCoordinator, GatedTunMutationAdapter } from './tun/coordinator'
import { MihomoHotSwitchTunAdapter } from './tun/hot-switch-adapter'
import { TunConfigService } from './tun/tun-config-service'
import { TunServiceClient } from './tun/service-client'
import { NamedPipeTunServiceTransport } from './tun/named-pipe-transport'
import { tunServiceIdentity } from './tun/service-identity'
import { waitForTunDataPlaneReady } from './tun/data-plane-readiness'
import { ModeTransitionController, queuedKernelGateway, queuedTunGateway } from './kernel/mode-transition'
import type { TunGateway, TunStatus } from '../shared/tun'

const devControllerUrl = process.env.MURGE_DEV_CONTROLLER ?? 'http://127.0.0.1:9090'
const devControllerSecret = process.env.MURGE_DEV_SECRET ?? ''

// CI-only flag routing for the interactive Windows GUI smoke workflow. Accept
// the same flags through MURGE_CI_BOOT_FLAGS so a self-hosted runner can forward
// probes through launch wrappers without weakening normal user launches.
const ciBootFlags = (process.env.MURGE_CI_BOOT_FLAGS ?? '')
  .split(/\s+/)
  .map((flag) => flag.trim())
  .filter(Boolean)
const hasArg = (flag: string): boolean => process.argv.includes(flag) || ciBootFlags.includes(flag)
const launchHidden = hasArg('--hidden')
const skipKernelAutostart =
  process.env.GITHUB_ACTIONS === 'true' && hasArg('--no-kernel-autostart')

// Diagnostics: dump the exact argv + boot flags the packaged process parsed, so
// a CI spin shows ground truth about whether the probe flag survived delivery.
// Only writes when the workflow exports MURGE_CI_BOOT_DIAG=1 and a path.
if (process.env.MURGE_CI_BOOT_DIAG === '1' && process.env.MURGE_CI_BOOT_DIAG_PATH) {
  try {
    writeFileSync(
      process.env.MURGE_CI_BOOT_DIAG_PATH,
      JSON.stringify(
        { argv: process.argv, bootFlags: ciBootFlags, cwd: process.cwd() },
        null,
        2
      )
    )
  } catch {
    /* diagnostics must never break the app */
  }
}

// CI-only loading-time watchdog for the interactive Windows smoke workflow. If
// a packaged `--packaging-smoke` probe stalls in Electron initialization,
// Electron stalls anywhere in startup (window-ready, migration, profile
// resolution, sentinel write) the process would otherwise hang for the workflow
// timeout. Arm a timer at module load so it fires no matter WHY startup stalls,
// and exit non-zero so the workflow fails fast with a deterministic message
// instead of timing out silently. A healthy probe reaches runPackagingSmoke and
// exits 0 long before this fires.
if (hasArg('--packaging-smoke')) {
  setTimeout(() => {
    console.error('[packaging-smoke] watchdog: app never reached runPackagingSmoke within 60s; forcing exit')
    process.exit(1)
  }, 60000)
}

// Headless CI runners often have no GPU/display, and Electron can stall in
// window-ready waiting on GPU init. For the CI probe modes (which never open a
// GUI and exit fast) disable hardware acceleration so startup resolves; normal
// user launches keep it.
if (
  hasArg('--packaging-smoke') ||
  hasArg('--kernel-smoke') ||
  hasArg('--ui-smoke') ||
  hasArg('--hidden-smoke') ||
  hasArg('--system-proxy-enable')
) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

// Production pins the application-data directory to a stable, product-name-free
// namespace (see storage/app-data.ts) so a future rename never orphans user
// data. This must run before the ready event so every Electron subsystem that
// derives paths from `userData` (localStorage, caches, session) resolves it
// consistently. Dev builds leave the default path and the ephemeral profile
// workspace untouched — dev builds never persist real user data.
if (!is.dev) {
  app.setPath('userData', appDataRoot(app.getPath('appData')))
}

// Created inside app.whenReady; held here so the quit path can stop it.
let kernel: KernelGateway | null = null
let mihomo: MihomoService | null = null
let systemProxy: SystemProxyService | null = null
let mockServer: MockMihomoServerHandle | null = null
let disposeIpc: (() => void) | null = null
let isQuitting = false
let shutdownPromise: Promise<void> | null = null
/**
 * Last-known persisted app settings, mirrored from the settings service so
 * synchronous event handlers (window close, proxy-guard tick, login-item
 * args) never need an async settings read mid-event.
 */
let cachedAppSettings: AppSettings = { ...DEFAULT_APP_SETTINGS }
let subStoreServiceRef: SubStoreService | null = null
// Keep a strong reference for the complete lifetime of the native window.
// A function-local BrowserWindow can be garbage-collected after createWindow
// returns, which is especially visible in packaged Windows builds as a running
// background process with no window.
let mainWindow: BrowserWindow | null = null
let trayController: TrayController | null = null
let disposeRuntimeAppearance: (() => void) | null = null
let tunCoordinator: TunCoordinator | null = null
let modeTransition: ModeTransitionController | null = null
let tunExitMonitor: { stop(): void } | null = null
let proxyGuardTimer: NodeJS.Timeout | null = null
let networkDetector: NetworkDetector | null = null
let runtimeIntentRecovery: RuntimeIntentRecoveryCoordinator | null = null
let updateService: UpdateService | null = null
let usageHistoryServiceRef: UsageHistoryService | null = null
let waitForProfileOperations: (() => Promise<void>) | null = null

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
 * the opt-in kernel lifecycle over the randomized loopback controller; no
 * system-network setting is changed.
 */
async function createMihomoGateway(
  productionController?: { url: string; secret: string },
  resolveGroupTestUrls?: () => Promise<Record<string, string | null>>,
  resolveDelayTestSettings?: () => Promise<{ scope: 'group' | 'global'; url: string }>
): Promise<MihomoGateway> {
  if (is.dev) {
    const secret = devControllerSecret || 'dev-mock-secret'
    mockServer = await startMockMihomoServer({ secret })
    const client = new MihomoClient(mockServer.baseUrl, secret)
    mihomo = new MihomoService(client, {
      wsBaseUrl: mockServer.wsBaseUrl,
      secret,
      enabled: true,
      resolveGroupTestUrls,
      resolveDelayTestSettings
    })
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
        enabled: true,
        resolveGroupTestUrls,
        resolveDelayTestSettings
      }
    )
  }
  return mihomo
}

/** Preferred ecosystem-standard mihomo mixed inbound. */
const MIHOMO_MIXED_PORT = 7890

async function allocateProductionPorts(): Promise<{ controller: number; mixed: number }> {
  const mixed = await findFreePort(MIHOMO_MIXED_PORT)
  let controller = await findFreePort()
  // Prefer clash-party's conventional 7890 so scripts and browser extensions
  // keep working, but fall back when another proxy app already owns it. All
  // internal consumers receive the resolved port, so a collision must not turn
  // into a kernel-start failure. The controller remains ephemeral.
  while (controller === mixed) controller = await findFreePort()
  // Known accepted TOCTOU: nothing is bound here and mihomo binds some seconds
  // later, so another process can claim a port in between. The failure mode is
  // a loud kernel-start error (user retries), not silent corruption — holding
  // the sockets open would starve mihomo's bind instead.
  return { controller, mixed }
}

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
    width: 934,
    height: 672,
    useContentSize: true,
    minWidth: 848,
    minHeight: 640,
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
    // Close-to-tray (verge's 最小化到托盘而非退出): the tray application stays
    // alive. With the preference off, the close button quits through the SAME
    // bounded restore-and-shutdown flow as the tray menu, so an owned system
    // proxy is always restored before the process exits.
    if (cachedAppSettings.closeToTray) {
      window.hide()
      return
    }
    void beginApplicationShutdown(false)
  })
  // Windows does not guarantee Electron's application-level before-quit event
  // during logoff/restart/shutdown. Start the same bounded network cleanup from
  // the native window session-end notification as a best-effort head start.
  if (process.platform === 'win32') {
    window.on('session-end', () => {
      void beginApplicationShutdown(true)
    })
  }

  // `ready-to-show` is an optimisation, not a visibility gate. Renderer load
  // failures and some Windows/GPU combinations may never emit it, so also show
  // after the document finishes loading. Both handlers are idempotent.
  const showWindow = (): void => {
    if (launchHidden) return
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }
  window.once('ready-to-show', showWindow)
  window.webContents.once('did-finish-load', showWindow)
  if (hasArg('--ui-smoke')) {
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
  try {
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
    // On an automated Windows runner `app.exit(0)` can fail to tear the process
    // down even though no window/kernel exists, leaving the CI step to time out.
    // Arm a hard-exit watchdog so the probe can never hang the workflow, then
    // exit normally. The watchdog is unref'd so a healthy `app.exit` is unaffected.
    const watchdog = setTimeout(() => process.exit(0), 3000)
    watchdog.unref()
    app.exit(0)
  } catch (error) {
    // A failed sentinel must not hang the process either: report and fail fast
    // so CI surfaces the actual reason instead of timing out silently.
    console.error('[packaging-smoke] failed to write the sentinel:', error)
    app.exit(1)
  }
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
  // to keep the dev machine's network path untouched. Production builds use real fetch.
  // Production additionally wires a kernel-proxy fallback transport: Node's
  // global fetch ignores the system proxy, so a subscription host that is only
  // reachable through the tunnel fails with a bare "fetch failed". The fallback
  // goes through Chromium's network stack (net.request), which DOES honor the
  // system proxy — i.e. the app's own mixed port when the system proxy is
  // enabled — so UPDATE reaches the same hosts the ADD path could. Redirects
  // are intercepted hop-by-hop and re-validated by SubscriptionFetcher (see
  // createSubscriptionProxyFetchFn for why net.fetch cannot be used here).
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
    : new SubscriptionFetcher({
        proxyFetchFn: createSubscriptionProxyFetchFn()
      })

  const proxySelectionStore = new ProxySelectionStore(appDataRoot(app.getPath('appData')))
  const profileService = new ProfileService(
    new ProfileRepository({ rootDir: profileRoot, validator }),
    validator,
    subscriptionFetcher,
    new EncryptedProfileSourceStore(join(profileRoot, '.sources'), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value)
    }),
    // Deleting a profile drops its remembered node picks too (fire-and-forget:
    // the profile is already gone, a cache-cleanup failure must not fail delete).
    (deletedId) => { void proxySelectionStore.deleteProfile(deletedId).catch(() => undefined) }
  )

  // CI-only startup probe (see `windows-gui-smoke`). Verifies production
  // storage wiring and that packaging did not break the launch path, without
  // opening a window, starting a kernel, or binding any socket.
  if (hasArg('--packaging-smoke')) {
    await runPackagingSmoke(profileRoot)
    return
  }

  // Headless system-proxy restore (see runSystemProxyRestore). Used by the
  // uninstaller and CI whenever the GUI must not be started.
  if (hasArg('--restore-system-proxy')) {
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
  /** Proxy guard cadence (clash-verge-rev defaults to 30s; keep the same). */
  const PROXY_GUARD_INTERVAL_MS = 30_000
  // Installer-shipped geodata databases (Layer 2): resolved relative to the app
  // resources so the packaged app can seed the kernel's persistent home. Empty
  // in dev, where the resources dir does not carry them (fail-open: the kernel
  // then falls back to its own download path exactly as before).
  const geodataSeedDir = is.dev ? undefined : join(process.resourcesPath, 'geodata')
  const appSettingsService = new AppSettingsService(appDataRoot(app.getPath('appData')))
  // Hydrate before login-item and window behavior consume the synchronous mirror.
  cachedAppSettings = await appSettingsService.get()
  const startupService = new StartupService(new ElectronStartupAdapter(() => cachedAppSettings.silentLaunch))
  appSettingsService.onChange((settings) => {
    const silentLaunchChanged = settings.silentLaunch !== cachedAppSettings.silentLaunch
    cachedAppSettings = settings
    if (silentLaunchChanged) {
      void startupService.refreshRegistration().catch((error) => {
        console.error('[startup] failed to refresh login-item arguments:', error)
      })
    }
    void subStoreServiceRef?.onSettings({
      subStoreEnabled: settings.subStoreEnabled,
      subStoreUseProxy: settings.subStoreUseProxy
    }).catch((error) => {
      console.error('[substore] failed to apply settings:', error)
    })
  })
  const overrideService = new OverrideService(
    appDataRoot(app.getPath('appData')),
    undefined,
    async () => {
      const profile = await profileService.getActiveProfile()
      return profile ? { document: profile.document, profileId: profile.meta.id } : null
    }
  )
  const dnsEnhancementService = new DnsEnhancementService(appDataRoot(app.getPath('appData')))
  const snifferEnhancementService = new SnifferEnhancementService(appDataRoot(app.getPath('appData')))
  const tunConfigService = new TunConfigService(appDataRoot(app.getPath('appData')))
  const coreSettingsService = new CoreSettingsService(appDataRoot(app.getPath('appData')))
  const geodataSettingsService = new GeodataSettingsService(appDataRoot(app.getPath('appData')))

  // The single source of the runtime document, shared by the main kernel and the
  // privileged TUN path so both run byte-identical content. Ordered exactly as the
  // audit pipeline requires: overrides -> typed DNS -> sniffer, with the safety
  // pass applied afterwards by whichever consumer materializes the config. Keeping
  // this in one place is what stops TUN from silently ignoring the user's
  // overrides / DNS / sniffer settings.
  const resolveEnhancedActiveDocument = async (): Promise<string | null> => {
    const profile = await profileService.getActiveProfile()
    if (!profile) return null
    const overridden = await overrideService.applyForProfile(profile.document, profile.meta.id)
    const dnsApplied = await dnsEnhancementService.applyToDocument(overridden)
    return snifferEnhancementService.applyToDocument(dnsApplied)
  }
  const tunSupported = !is.dev && process.platform === 'win32'
  const kernelManagerService = new KernelManagerService({
    settings: appSettingsService,
    workspaceRoot: productionKernelRoot,
    // The production Windows LocalSystem service intentionally accepts only the
    // installer-pinned archive. Do not advertise a user-selected binary that the
    // privileged runtime cannot execute from a writable directory.
    specificVersionsSupported: !tunSupported
  })
  // Windows production uses the installed LocalSystem service as the ONE core
  // host in both ordinary and TUN modes. The same client is also used by the
  // liveness monitor, so ownership cannot split across independent handles.
  const tunServiceClient = tunSupported
    ? new TunServiceClient(new NamedPipeTunServiceTransport(tunServiceIdentity(brand.appId).pipeName))
    : null

  const kernelSupervisor = new KernelSupervisor(
    {
      resolver: is.dev
        ? createKernelResolver({ appPath: app.getAppPath(), mode: 'fixture' })
        : process.platform === 'win32'
          ? new MihomoKernelResolver({
              allowReal: true,
              workspaceDir: productionKernelRoot,
              bundledArchiveDir: join(process.resourcesPath, 'bin'),
              kernelEnabled: () => kernelManagerService.isEnabled(),
              versionSelection: () => kernelManagerService.getVersionSelection(),
              ensureSpecificBinary: (version) => kernelManagerService.ensureVersionBinary(version)
            })
          : createKernelResolver({ appPath: app.getAppPath(), mode: 'disabled' }),
      configStore: is.dev
        ? new TempKernelConfigStore()
        : new MihomoKernelConfigStore({
            mixedPort: productionMixedPort!,
            controllerPort: productionControllerPort!,
            workspaceDir: join(productionKernelRoot, 'runtime'),
            // Stable kernel home (`-d`): mihomo resolves geodata databases and
            // provider caches here, so the directory must persist across runs.
            // A per-run temp home forced a fresh online geodata download on
            // every start — which fails before any proxy exists (no DNS to
            // resolve the download host) and blocked startup entirely when the
            // profile carried GEOSITE/GEOIP rules.
            kernelHomeDir: join(productionKernelRoot, 'geodata'),
            // Installer-shipped geodata seeds the persistent home, so the very
            // first start never depends on the online download path.
            seedResourcesDir: geodataSeedDir,
            // Drive the live controller from the ACTIVE profile (proxies, groups,
            // rules, providers) instead of the strict direct-only bootstrap. Falls
            // back to the strict config when no profile is active (e.g. CI smoke).
            // Any enabled overrides (global + this profile's) are applied to the
            // profile document before the safety pass, so custom rules/groups/DNS
            // survive without editing the subscription file itself. The resolver is
            // shared with the privileged TUN path so both run identical content.
            resolveActiveDocument: resolveEnhancedActiveDocument,
            // Controlled core settings: when enabled, the allowlisted core keys
            // are authoritative in the runtime config (read-back) and override
            // the profile's own values (conflict handling); when disabled the
            // profile is preserved.
            resolveCore: () => coreSettingsService.getRaw(),
            // Controlled geodata settings: same contract as core settings.
            resolveGeodata: () => geodataSettingsService.getRaw()
          }),
      adapter: new NodeKernelProcessAdapter(),
      secret: is.dev ? devControllerSecret : productionSecret!,
      // Job-Object equivalent (Windows production): if the app is killed while
      // the kernel lives, the watchdog force-kills the kernel tree so a dead
      // GUI never leaves an orphan holding the unified ports / TUN device.
      attachWatchdog: is.dev || process.platform !== 'win32' ? undefined : attachKernelWatchdog
    },
    { readinessPattern: is.dev ? /fixture-ready/ : null }
  )
  const privilegedKernel = tunSupported && !hasArg('--kernel-smoke')
    ? new PrivilegedServiceKernelGateway(
        tunServiceClient!,
        () => ({
          controllerPort: productionControllerPort!,
          mixedPort: productionMixedPort!,
          secret: productionSecret!
        }),
        {
          readActiveDocument: resolveEnhancedActiveDocument,
          readTunConfig: () => tunConfigService.readConfig(),
          readCore: () => coreSettingsService.getRaw(),
          readGeodata: () => geodataSettingsService.getRaw()
        },
        {
          waitUntilReady: async ({ controllerPort, secret, signal }) => {
            const client = new MihomoClient(`http://127.0.0.1:${controllerPort}`, secret, { timeoutMs: 750 })
            while (!signal.aborted) {
              try {
                const version = await client.getVersion(signal)
                return { version: version.version }
              } catch {
                await new Promise<void>((resolve) => {
                  const timer = setTimeout(done, 100)
                  function done(): void {
                    clearTimeout(timer)
                    signal.removeEventListener('abort', done)
                    resolve()
                  }
                  signal.addEventListener('abort', done, { once: true })
                })
              }
            }
            throw new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, 'privileged mihomo controller did not become ready')
          }
        },
        `${brand.shortName} TUN`,
        10_000,
        () => kernelManagerService.isEnabled()
      )
    : null
  // A service-owned core surviving an abnormal GUI exit may still own TUN
  // routes. Stop it first, then replay the durable intent through the normal
  // startup coordinator. Normal launches therefore never inherit unknown state.
  if (privilegedKernel) {
    await privilegedKernel.initialize().catch((error) => {
      // A delayed Windows service can still be starting. Keep the UI usable;
      // the gateway's bounded start retry and runtime-intent recovery take over.
      console.warn('[kernel] privileged service startup reconciliation deferred:', error)
    })
  }
  const kernelInstance: KernelGateway = privilegedKernel ?? kernelSupervisor
  kernel = kernelInstance
  // Await the (mock or disabled) controller gateway before wiring IPC so the
  // renderer's first pull always sees a live controller in dev.
  const gateway = await createMihomoGateway(
    is.dev
      ? undefined
      : {
          url: `http://127.0.0.1:${productionControllerPort}`,
          secret: productionSecret!
        },
    async () => parseProxyGroupTestUrls((await resolveEnhancedActiveDocument()) ?? ''),
    async () => {
      const settings = await appSettingsService.get()
      return { scope: settings.delayTestUrlScope, url: settings.delayTestUrl }
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
  if (!is.dev && hasArg('--kernel-smoke')) {
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
  if (!is.dev && hasArg('--system-proxy-enable')) {
    await runSystemProxyEnable(ipcKernel, gateway)
    return
  }

  // System-proxy controller. The probe reads the *live* mixed-port from the
  // controller (never a hard-coded value); the backup store lives in the stable
  // brand-independent app-data namespace so a crash mid-apply is recoverable.
  // `init()` restores any orphan from a previous crash before the UI is usable.
  //
  // TUN is created further down (it needs this service's ordering guarantees), so
  // the probe reads the coordinator through a late-bound holder rather than a
  // constructor argument. Until TUN exists this reports null and the probe behaves
  // exactly like the main-kernel-only path.
  // Single logical-kernel holder for the system-proxy probe. The probe consults
  // the SAME unified kernel view the renderer sees (running whenever either the
  // main kernel OR the elevated TUN child is serving, over the single production
  // controller/mixed ports). This replaces the legacy coexistence probe that
  // consulted the main-only kernel and reported a stopped kernel while TUN owned
  // the data plane — the source of the "请先启动内核后再启用系统代理" failure —
  // and lets the system proxy be enabled in BOTH modes on the one unified port.
  // The single-kernel gateway is created further down, so this is bound lazily
  // after it is wired; init() never enables, so the probe is first called after
  // the binding is assigned.
  let singleKernelGatewayRef: KernelGateway | null = null
  const singleKernelProbeGateway = new LateBoundKernelGateway(() => singleKernelGatewayRef)
  const systemProxyService = createSystemProxy({
    appDataBase: app.getPath('appData'),
    isDev: is.dev,
    kernel: ipcKernel,
    mihomo: gateway,
    // In single-kernel mode the system proxy simply points at the one unified
    // mixed-port, whatever host is live, so the live probe needs nothing beyond
    // the unified kernel + controller. On non-Windows the platform adapter is
    // unsupported and the factory's default probe is used.
    probe: is.dev
      ? undefined
      : process.platform === 'win32'
        ? new LiveSystemProxyKernelProbe(singleKernelProbeGateway, gateway)
        : undefined
  })
  systemProxy = systemProxyService
  await systemProxyService.init()

  // Order the proxy restore ahead of kernel shutdown: a user stop restores the
  // system proxy first and aborts the stop if that restoration genuinely fails,
  // so the proxy never points at a dead port.
  const orderedKernel = new SystemProxyOrderedKernelGateway(ipcKernel, systemProxyService)

  // Crash the controller while the proxy was owned: the port is now dead, so
  // restore the proxy immediately (conflict is safe — the proxy is not ours —
  // while a real restore failure stays visible as `restore-failed`). Re-enable
  // is deliberately left to the durable-intent recovery coordinator below: a
  // cached crash-time boolean could otherwise turn the proxy back on after the
  // user explicitly switched it off while recovery was in flight.
  orderedKernel.onStatus((status) => {
    if (status.phase === 'failed') {
      void systemProxyService.restoreBeforeKernelUnavailable().catch((error) => {
        console.error('[system-proxy] kernel crash recovery failed:', error)
      }).finally(() => runtimeIntentRecovery?.wake())
    }
  })

  // Proxy guard (clash-verge-rev's guard loop on this app's ownership model): while
  // we own an enabled proxy, re-apply our exact written values if something on
  // the box mutated them — the "proxy is on but nothing loads" failure. Values
  // we do not own are never fought; the sweep is a read-only no-op otherwise.
  proxyGuardTimer = setInterval(() => {
    if (!cachedAppSettings.proxyGuard) return
    void systemProxyService.verifyIntegrity().then((result) => {
      if (result === 'repaired') console.warn('[system-proxy] guard repaired an externally mutated proxy')
      else if (result === 'repair-failed') console.error('[system-proxy] guard re-apply failed')
    })
  }, PROXY_GUARD_INTERVAL_MS)

  const tunAdapter = tunSupported
    ? new MihomoHotSwitchTunAdapter(
        gateway,
        () => ({
          controllerPort: productionControllerPort!,
          mixedPort: productionMixedPort!,
          secret: productionSecret!
        }),
        {
          waitUntilReady: async ({ controllerPort, secret, signal }) => {
            const client = new MihomoClient(`http://127.0.0.1:${controllerPort}`, secret, { timeoutMs: 500 })
            await waitForTunDataPlaneReady(client, signal)
          }
        },
        async () => tunConfigService.readConfig(),
        20_000,
        // clash-party DNS-takeover parity: TUN hijacks port 53 only when the
        // final active document (overrides -> DNS -> sniffer) leaves the DNS
        // module enabled. Resolved per enable() call so a toggle in the UI takes
        // effect on the next TUN switch without a kernel restart.
        async () => documentDnsEnabled(await resolveEnhancedActiveDocument())
      )
    : new GatedTunMutationAdapter()
  const tunInstance = new TunCoordinator(tunAdapter, tunSupported)
  tunCoordinator = tunInstance
  if (tunSupported) {
    await tunInstance.initialize().catch((error) => {
      console.error('[tun] service reconciliation failed:', error)
    })
  }
  // One mode-transition queue for EVERY host switch: kernel start/stop, TUN
  // enable/disable and failure recovery all become exclusive tasks on the same
  // FIFO, so no two of them can interleave a prepare/stop/resume sequence.
  // The raw TUN gateway is handed to the controller (it provides the exclusive
  // execution context); the IPC-facing gateways below are the queued wrappers.
  const rawTunGateway: TunGateway = {
    getStatus: () => tunInstance.getStatus(),
    enable: () =>
      tunInstance.enable({
        schemaVersion: 2,
        device: `${brand.shortName} TUN`,
        stack: 'mixed'
      }),
    disable: () => tunInstance.emergencyDisable(),
    onStatus: (listener) => tunInstance.onStatus(listener)
  }

  // Windows production now has one service-owned process for both modes; on
  // unsupported/dev platforms this remains the ordinary ordered gateway. No
  // synthetic "either host" view is needed because there is only one host.
  const runtimeKernelGateway = orderedKernel
  // Bind the system-proxy probe's holder to the unified gateway once it exists, so
  // the probe and the renderer's kernel.status.phase resolve the same live host.
  singleKernelGatewayRef = runtimeKernelGateway

  const modeController = new ModeTransitionController({
    kernel: runtimeKernelGateway,
    tun: rawTunGateway,
    systemProxy: systemProxyService,
    strategy: tunSupported ? 'in-place' : 'host-handoff',
    onError: (error, step) => console.error(`[mode-transition] ${step}:`, error)
  })
  modeTransition = modeController
  // The IPC-facing gateways go through THE ONE mode-transition queue, so kernel
  // start/stop and TUN enable/disable can never interleave their
  // prepare/stop/resume sequences (no second host can claim the unified ports
  // in between).
  const queuedKernel = queuedKernelGateway(runtimeKernelGateway, modeController)
  const queuedTun = queuedTunGateway(rawTunGateway, modeController)

  // The service owns the only process, so monitor it regardless of whether TUN
  // is currently enabled. A confirmed unexpected exit first restores an owned
  // system proxy, then wakes the durable-intent recovery loop to recreate the
  // same service core and desired TUN state.
  if (privilegedKernel) {
    let probingPrivilegedKernel = false
    const monitor = setInterval(() => {
      if (probingPrivilegedKernel) return
      const phase = privilegedKernel.getStatus().phase
      if (phase !== 'running' && phase !== 'starting') return
      probingPrivilegedKernel = true
      void privilegedKernel.reconcileLiveness()
        .then(async (live) => {
          if (live) return
          await tunInstance.handleHostExit()
          await systemProxyService.restoreBeforeKernelUnavailable().catch((error) => {
            console.error('[system-proxy] privileged core exit recovery failed:', error)
          })
          const settings = await appSettingsService.get()
          if (settings.autoStartKernel && !settings.tunDesired && !settings.systemProxyDesired) {
            await queuedKernel.start().catch((error) => console.error('[kernel] privileged core restart failed:', error))
          } else {
            runtimeIntentRecovery?.wake()
          }
        })
        .catch((error) => console.error('[kernel] privileged service liveness probe failed:', error))
        .finally(() => { probingPrivilegedKernel = false })
    }, 5_000)
    tunExitMonitor = { stop: () => clearInterval(monitor) }
  }

  // Connectivity watchdog: while offline, restore owned proxy/TUN state and
  // stop the shared host; when the network returns, replay the remembered run
  // mode through the same service-backed lifecycle. It lives after
  // `queuedKernel`, so no lazy closure can touch a TDZ binding.
  networkDetector = new NetworkDetector({
    intervalSeconds: 15,
    log: (message) => console.log(message),
    gateway: {
      getRunMode: async () => {
        const tunPhase = tunInstance.getStatus().phase
        if (tunPhase === 'active' || tunPhase === 'starting' || tunPhase === 'restoring') return 'tun'
        const status = runtimeKernelGateway.getStatus()
        const resolved = status instanceof Promise ? await status : status
        return resolved.phase === 'running' ? 'kernel' : 'stopped'
      },
      startKernel: () => queuedKernel.start(),
      startTun: () => queuedTun.enable(),
      stopKernel: () => queuedKernel.stop(),
      handleNetworkDown: () => systemProxyService.handleNetworkDown(),
      handleNetworkUp: async () => {
        try {
          return await systemProxyService.handleNetworkUp()
        } finally {
          runtimeIntentRecovery?.wake()
        }
      }
    }
  })
  // A resume must not wait for the next periodic tick to reconcile.
  powerMonitor.on('resume', () => {
    void networkDetector?.probeNow()
      .catch((error) => {
        console.error('[network-detector] resume probe failed:', error)
      })
      .finally(() => runtimeIntentRecovery?.wake())
  })
  // `session-end` is the most direct Windows signal, but it belongs to a native
  // window and is not guaranteed if Windows tears the session down before that
  // window receives WM_ENDSESSION. Electron's application-level shutdown event
  // is an independent best-effort entry point used by clash-party/sparkle. The
  // shared shutdownPromise makes both signals idempotent.
  powerMonitor.on('shutdown', () => {
    void beginApplicationShutdown(true)
  })

  // Reapplies the active profile to the live kernel whenever the user edits,
  // activates or imports-as-active a profile. The reloader runs INSIDE the mode
  // queue (no-op when the kernel is stopped; a running kernel restarts
  // stop-then-start through the unified gateway, preserving any owned system
  // proxy). A full profile replacement may still restart the one service core,
  // then restores the previous TUN intent. The concrete profileService is used
  // directly by the kernel config store's resolveActiveDocument, so both paths
  // read the same repository.
  const profileGateway = new ProfileAutoReloadGateway({
    inner: profileService,
    autoActivateOnEdit: true,
    reloader: {
      reload: async (rollbackActive) => {
        await modeController.reloadProfile((kernel) =>
          reloadKernelForActiveProfile({
            kernel,
            systemProxy: systemProxyService
          }, { rollbackActive })
        )
        // The kernel came back up on the (possibly new) active profile: replay
        // that profile's remembered node picks so they survive the restart.
        await proxySelectionService.restoreSelections()
      }
    }
  })
  waitForProfileOperations = () => profileGateway.waitForIdle()
  // Per-profile node-pick cache (sparkle/clash-party model): every accepted
  // selectProxy is remembered, and each kernel reload replays the picks so a
  // restart/profile-switch restores the user's nodes instead of config defaults.
  const proxySelectionService = new ProxySelectionService(
    gateway,
    profileGateway,
    proxySelectionStore
  )
  const updates = new UpdateService(new ElectronUpdaterDriver())
  updateService = updates
  updates.start()
  // Poll the feed while the app runs so a Release published mid-session is
  // picked up without waiting for the next launch (10-minute cadence, same as
  // mihomo-party/sparkle). The service no-ops this on non-packaged builds.
  updates.startPolling()
  const usageHistoryService = new UsageHistoryService({
    store: app.isPackaged
      ? FileSystemUsageHistoryStore.forAppDataBase(app.getPath('appData'))
      : new InMemoryUsageHistoryStore(),
    onTraffic: (listener) => gateway.onTraffic(listener)
  })
  await usageHistoryService.init()
  usageHistoryServiceRef = usageHistoryService
  // Sub-Store (配置-外部资源): lifecycle owner for the on-demand backend worker.
  // Started only when the page asks for it while enabled — never at boot.
  const subStoreService = new SubStoreService({
    baseDir: join(appDataRoot(app.getPath('appData')), 'substore'),
    brandName: brand.productName,
    getMixedPort: () => productionMixedPort,
    appSettings: appSettingsService
  })
  subStoreServiceRef = subStoreService
  const networkMetadataService = new NetworkMetadataService({
    resolveProxyPort: async () => {
      try {
        if ((await runtimeKernelGateway.getStatus()).phase !== 'running') return null
        const config = await gateway.getConfig()
        const port = config['mixed-port'] ?? config.port
        return typeof port === 'number' && port > 0 ? port : null
      } catch {
        return null
      }
    },
    fetchJsonViaProxy: fetchMetadataJsonViaProxy
  })
  // INTERNET-latency card: first-hop gateway RTT (direct, kernel-independent),
  // the kernel's DNS resolve time, and the controller-reported delay of the
  // node the user's selector currently points at (the full proxy-chain RTT).
  const internetLatencyService = new InternetLatencyService({
    mihomo: gateway,
    resolveGroupOrder: async () => {
      const active = await profileService.getActiveProfile()
      return active ? parseProxyGroupOrder(active.document) : []
    }
  })
  // 解锁测试 probes go through the kernel's LIVE mixed port (clash-verge-rev
  // semantics) so the verdict is about the selected node's egress regardless
  // of system-proxy state; kernel down fails closed instead of sampling DIRECT.
  const serviceUnlockService = new ServiceUnlockService({
    resolveMixedPort: async () => {
      try {
        const config = await gateway.getConfig()
        return config['mixed-port'] ?? null
      } catch {
        return null
      }
    }
  })
  disposeIpc = registerIpc({
    internetLatency: internetLatencyService,
    unlock: serviceUnlockService,
    kernel: queuedKernel,
    kernelManager: kernelManagerService,
    // The selection-recording wrapper is what the renderer talks to; the raw
    // gateway stays available for internal reads (restore, network metadata).
    mihomo: new ProxySelectionGateway(
      gateway,
      proxySelectionService,
      (operation) => profileGateway.runExclusive(operation)
    ),
    profiles: profileGateway,
    systemProxy: systemProxyService,
    startup: startupService,
    appSettings: appSettingsService,
    overrides: overrideService,
    dns: dnsEnhancementService,
    sniffer: snifferEnhancementService,
    tunConfig: tunConfigService,
    core: coreSettingsService,
    geodata: geodataSettingsService,
    updates,
    tun: queuedTun,
    usageHistory: usageHistoryService,
    networkMetadata: networkMetadataService,
    subStore: subStoreService,
    resolveActiveGroupOrder: async () =>
      parseProxyGroupOrder((await resolveEnhancedActiveDocument()) ?? ''),
    resolveActiveProviderCatalog: async () =>
      parseProviderCatalog((await resolveEnhancedActiveDocument()) ?? '')
  })
  createWindow()
  const showMainWindow = (): void => {
    const window = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? createWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  const trayIconRoot = is.dev
    ? join(app.getAppPath(), 'resources', 'tray')
    : join(process.resourcesPath, 'tray')
  const trayView = createElectronTray(trayIconRoot, nativeTheme.shouldUseDarkColors)
  trayController = new TrayController({
    productName: brand.productName,
    // Tray start/stop goes through the ONE mode-transition queue like every
    // other entry point (queuedKernel.stop() keeps the unified gateway's
    // restore-proxy-before-stop ordering when TUN is serving).
    kernel: queuedKernel,
    view: trayView,
    showWindow: showMainWindow,
    quit: () => app.quit(),
    onCheckUpdate: () => { void updates.check().catch((error) => console.warn('[updates] tray check failed:', error)) },
    onError: (error) => console.error('[tray] kernel action failed:', error)
  })
  await trayController.initialize()
  const updateRuntimeAppearance = (): void => {
    const accent = resolveRuntimeAccent(
      systemProxyService.getStatus().phase,
      tunInstance.getStatus().phase
    )
    const dark = nativeTheme.shouldUseDarkColors
    trayView.setRuntimeAppearance(accent, dark)
  }
  const unsubscribeProxyAppearance = systemProxyService.onStatus(updateRuntimeAppearance)
  const unsubscribeTunAppearance = tunInstance.onStatus(updateRuntimeAppearance)
  nativeTheme.on('updated', updateRuntimeAppearance)
  disposeRuntimeAppearance = () => {
    unsubscribeProxyAppearance()
    unsubscribeTunAppearance()
    nativeTheme.removeListener('updated', updateRuntimeAppearance)
  }
  updateRuntimeAppearance()

  // CI-only installed-artifact proof for the real login-launch shape. It
  // creates the hidden BrowserWindow and native Tray, but never starts mihomo
  // or mutates proxy/TUN/DNS.
  if (!is.dev && hasArg('--hidden-smoke')) {
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

  // Restore the user's last requested networking state after BOTH recovery
  // layers above have completed: systemProxyService.init() has restored an
  // orphaned registry backup, and tunInstance.initialize() has reconciled an
  // interrupted privileged transaction. Login launches use `--hidden`, but
  // must still restore the requested state; only the explicit Actions smoke
  // flag suppresses it. Operations are sequential and bounded: ordinary host
  // ready -> hot-enable TUN -> system proxy on the unchanged mixed-port.
  if (!is.dev && !skipKernelAutostart) {
    const runtimeIntentDeps = {
      kernel: queuedKernel,
      tun: queuedTun,
      systemProxy: systemProxyService,
      restoreSelections: async (): Promise<void> => {
        await proxySelectionService.restoreSelections()
      },
      log: (message: string, error?: unknown): void => console.warn(message, error ?? '')
    }
    try {
      const settings = await appSettingsService.get()
      const restored = await restoreRuntimeIntent(settings, runtimeIntentDeps)
      if (settings.tunDesired && restored.tun.phase !== 'active') {
        console.warn(`[startup-restore] TUN intent remains pending (${restored.tun.phase})`)
      }
      if (settings.systemProxyDesired && restored.systemProxyPhase !== 'enabled') {
        console.warn(`[startup-restore] system proxy intent remains pending (${restored.systemProxyPhase})`)
      }
    } catch (error) {
      console.warn('[startup-restore] failed to restore runtime intent:', error)
    }
    runtimeIntentRecovery = new RuntimeIntentRecoveryCoordinator({
      settings: appSettingsService,
      restore: runtimeIntentDeps,
      log: (message, error) => console.warn(message, error ?? '')
    })
    runtimeIntentRecovery.start()
  }

  // Arm connectivity recovery only after startup reconciliation. This prevents
  // the first detector tick from racing a slow Windows TUN service bootstrap;
  // later offline/online and resume transitions continue to use the same
  // serialized mode queue.
  networkDetector.start()

  // Auto-check for a newer release on launch, gated on the persisted
  // "启动时自动检查更新" setting. `check()` kicks off the feed request and returns
  // immediately, so this never blocks the window; a found update downloads in
  // the background and installs on the next quit, while a manual "检查更新"
  // from "关于" or the tray always works regardless of this flag. Wrapped so a
  // transient network failure only logs and never blocks startup.
  if (!is.dev) {
    try {
      const settings = await appSettingsService.get()
      if (settings.autoCheckUpdate) {
        await updates.check()
      }
    } catch (error) {
      console.warn('[updates] auto-check failed:', error)
    }
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
  // Inside the ONE mode-transition queue, so a concurrent renderer start/stop
  // can never interleave with the shutdown sequence.
  const task = async (): Promise<boolean> => {
    // Restore the owned system proxy FIRST, while the live host (the elevated
    // TUN child or the main kernel) still holds the unified mixed port. This
    // mirrors every other teardown path (single-kernel-gateway.stop,
    // ordered-kernel-gateway.stop): the registry must never aim at a port that
    // is about to close. The quit path never resumes the main kernel, so
    // stopping the TUN child first would leave a bounded dead-port window.
    const restored = await restoreSystemProxyBeforeQuit()
    if (tunCoordinator) {
      try {
        const status: TunStatus = await tunCoordinator.emergencyDisable()
        if (status.phase !== 'configured' && status.phase !== 'unsupported') {
          console.error('[tun] TUN stop was not confirmed during quit:', status.phase)
        }
      } catch (error) {
        console.error('[tun] restore during quit failed:', error)
      }
    }
    return restored
  }
  if (modeTransition) return modeTransition.runExclusive(task)
  return task()
}

function beginApplicationShutdown(sessionEnding: boolean): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  isQuitting = true
  shutdownPromise = (async () => {
    // Proxy selections share the profile mutation queue through their durable
    // per-profile write. Drain accepted work before tearing IPC and storage down.
    await waitForProfileOperations?.()
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
          await kernel?.stop()
        }
        if (modeTransition) await modeTransition.runExclusive(stop)
        else await stop()
      },
      dispose: async () => {
        try {
          tunExitMonitor?.stop()
          tunExitMonitor = null
          disposeRuntimeAppearance?.()
          disposeRuntimeAppearance = null
          trayController?.dispose()
          disposeIpc?.()
          updateService?.dispose()
          usageHistoryServiceRef?.dispose()
          if (proxyGuardTimer) {
            clearInterval(proxyGuardTimer)
            proxyGuardTimer = null
          }
          networkDetector?.stop()
          networkDetector = null
          runtimeIntentRecovery?.stop()
          runtimeIntentRecovery = null
          subStoreServiceRef?.dispose()
          subStoreServiceRef = null
          mihomo?.dispose()
          await mockServer?.close()
        } catch (error) {
          console.error('[mihomo] failed to stop mock controller during quit:', error)
        } finally {
          trayController = null
          disposeIpc = null
          updateService = null
          usageHistoryServiceRef = null
          waitForProfileOperations = null
        }
      },
      // Session-end is already inside the Windows logoff/shutdown path; app.exit
      // avoids re-entering before-quit after the bounded cleanup completes.
      quit: () => sessionEnding ? app.exit(0) : app.quit(),
      onCleanupError: (error, step) => console.error(`[quit-guard] ${step} failed during quit:`, error)
    })
    if (result === 'restore-failed') {
      shutdownPromise = null
      if (sessionEnding) {
        // Windows may terminate the process immediately. Preserve the proxy
        // backup/TUN journal so init() can restore them before replaying the
        // saved user intent on the next launch.
        app.exit(0)
        return
      }
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
  return shutdownPromise
}

app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  void beginApplicationShutdown(false)
})
