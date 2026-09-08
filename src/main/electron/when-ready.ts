import { app, powerMonitor, safeStorage } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { brand } from '@shared/brand'
import type { KernelGateway } from '@shared/gateways'
import { parseBrandConfig } from '@shared/schemas/brand'
import { registerIpc } from '../ipc/register-ipc'
import { KernelSupervisor } from '../kernel/supervisor'
import { createKernelResolver, MihomoKernelResolver } from '../kernel/resolvers'
import { TempKernelConfigStore } from '../kernel/config-store'
import { MihomoKernelConfigStore } from '../kernel/mihomo-config-store'
import { randomSecret } from '../kernel/mihomo-config'
import { ControllerReadyKernelGateway } from '../kernel/controller-ready-gateway'
import { LateBoundKernelGateway } from '../kernel/single-kernel-gateway'
import { PrivilegedServiceKernelGateway } from '../kernel/privileged-service-gateway'
import { proxyPortsOwnedByPid } from '../kernel/proxy-port-reclaimer'
import { createSystemProxy } from '../system-proxy/factory'
import { LiveSystemProxyKernelProbe, type LiveProbeMihomo } from '../system-proxy/probe'
import { SystemProxyOrderedKernelGateway } from '../system-proxy/ordered-kernel-gateway'
import { NetworkDetector } from '../services/network-detector'
import { NodeKernelProcessAdapter } from '../kernel/node-adapter'
import { MihomoClient } from '../services/mihomo-client'
import { MihomoService } from '../services/mihomo-service'
import { UsageHistoryService } from '../services/usage-history-service'
import { FileSystemUsageHistoryStore, InMemoryUsageHistoryStore } from '../services/usage-history-store'
import { NetworkMetadataService, fetchMetadataJsonViaProxy } from '../services/network-metadata-service'
import { RemoteIconCache } from '../services/remote-icon-cache'
import { ProfileRepository } from '../profiles/profile-repository'
import { EncryptedProfileSourceStore } from '../profiles/profile-source-store'
import { ProfileService } from '../profiles/profile-service'
import { ProfileAutoReloadGateway } from '../profiles/profile-auto-reload-gateway'
import { parseProxyGroupOrder, parseProxyGroupTestUrls } from '../profiles/proxy-group-order'
import { parseProviderCatalog } from '../profiles/provider-configs'
import { inspectActiveProfileConfig } from '../profiles/profile-config-inspection'
import { buildProfileKernelConfig } from '../kernel/profile-kernel-config'
import { generateProxiedTunConfig } from '../tun/mihomo-tun-config'
import { ServiceUnlockService } from '../services/service-unlock-service'
import { ProxySelectionStore } from '../profiles/proxy-selection-store'
import { ProxySelectionService } from '../services/proxy-selection-service'
import { ProxySelectionGateway } from '../services/proxy-selection-gateway'
import { createConfigValidator } from '../profiles/config-validator'
import { reloadKernelForActiveProfile } from '../system-proxy/reload-kernel'
import { SubscriptionFetcher } from '../subscriptions/subscription-fetcher'
import { createSubscriptionProxyFetchFn } from '../subscriptions/proxy-fetch-transport'
import { UpdateService } from '../updates/service'
import { ElectronUpdaterDriver } from '../updates/electron-updater-driver'
import { KernelManagerService } from '../kernel/kernel-manager-service'
import { ScheduledTaskStartupAdapter } from '../startup/scheduled-task-adapter'
import { StartupService } from '../startup/service'
import { restoreRuntimeIntent } from '../startup/runtime-intent'
import { RuntimeIntentRecoveryCoordinator } from '../startup/runtime-intent-recovery'
import { SubStoreService } from '../substore/service'
import { OverrideService } from '../kernel/overrides/override-service'
import { DnsEnhancementService } from '../kernel/dns/dns-enhancement-service'
import { documentDnsEnabled } from '../kernel/dns/apply-dns'
import { SnifferEnhancementService } from '../kernel/sniffer/sniffer-enhancement-service'
import { GeodataSettingsService } from '../kernel/geodata-settings-service'
import { TunCoordinator, GatedTunMutationAdapter } from '../tun/coordinator'
import { MihomoHotSwitchTunAdapter } from '../tun/hot-switch-adapter'
import { TunConfigService } from '../tun/tun-config-service'
import { TunServiceClient } from '../tun/service-client'
import { NamedPipeTunServiceTransport } from '../tun/named-pipe-transport'
import { tunServiceIdentity } from '../tun/service-identity'
import { waitForTunDataPlaneReady } from '../tun/data-plane-readiness'
import { ModeTransitionController, queuedKernelGateway, queuedTunGateway } from '../kernel/mode-transition'
import { LiveConfigReloader } from '../kernel/live-config-reloader'
import {
  EnhancementApplyCoordinator,
  LiveDnsEnhancementGateway,
  LiveGeodataSettingsGateway,
  LiveSnifferEnhancementGateway
} from '../kernel/enhancement-live-gateway'
import { startMockMihomoServer } from '../testing/mock-mihomo-server'
import { InternetLatencyService } from '../services/internet-latency-service'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import type { KernelManagerServiceDeps } from '../kernel/kernel-manager-service'
import type { KernelVersionChannel } from '@shared/kernel-manager'
import type { MihomoGateway } from '@shared/gateways'
import type { MihomoLogMessage } from '@shared/mihomo-api'
import { IPC } from '@shared/ipc'
import type { TunGateway } from '@shared/tun'
import { createTrayAdapter, type TrayAdapter } from './tray-adapter'
import { bindUpdateService } from './update-adapter'
import { runPackagingSmoke, runSystemProxyRestore, runSystemProxyEnable } from './ci-probes-adapter'
import { reportFatalStartupError } from './lifecycle-adapter'
import { appDataRoot } from '../storage/app-data'
import type { ShellBootstrap } from './bootstrap'

/**
 * `app.whenReady` orchestration for the Electron shell (Phase 1).
 *
 * Moved verbatim from the former monolithic `src/main/index.ts`; the only
 * edits are the extraction seams — module-level mutable variables now live on
 * the shared {@link ApplicationState}, window/identity/deep-link code is the
 * window adapter, tray wiring is the tray adapter, quit flow is the lifecycle
 * adapter and the headless probes are the CI-probes adapter. Every
 * construction and await keeps its original position: startup order here is a
 * behavioral specification (see docs/tauri/phase0/PARITY_CHECKLIST.md §7).
 */
export async function runWhenReady(shell: ShellBootstrap): Promise<void> {
  const { boot, state, windowAdapter, lifecycle, fileLogs, appSettingsService, coreSettingsService } = shell
  const isDev = is.dev
  const launchHidden = boot.launchHidden
  const skipKernelAutostart = boot.skipKernelAutostart
  const hasArg = boot.hasArg
  try {
    await whenReadyBody()
  } catch (error) {
    await reportFatalStartupError(error, () => fileLogs.flush())
  }

  async function whenReadyBody(): Promise<void> {
    try {
      parseBrandConfig(brand)
    } catch (error) {
      console.error('[brand] invalid brand configuration:', error)
      app.exit(1)
      return
    }

    app.setName(brand.productName)

    // Windows runtime registration of the murge:// handler + taskbar identity.
    windowAdapter.registerIdentity()

    // A second instance launched via a deep link hands its argv over here.
    app.on('second-instance', (_event, argv) => {
      windowAdapter.onSecondInstance(argv)
    })

    // A deep link that launched this instance arrives in the initial argv.
    windowAdapter.queueLaunchDeepLink(process.argv)

    // Resolve the profile workspace for this build (warmup started at module
    // load; migration first, then the workspace).
    const profileRoot = await shell.storageWarmup

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
    const subscriptionFetcher = isDev
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
    // Core settings were warmed at module level; this resolves from cache.
    let persistedCoreSettings = await shell.coreSettingsWarm
    // The controller secret is user-configurable and must stay stable across
    // restarts so a dashboard can reconnect. New/reset installs receive a strong
    // generated value once; it is never replaced behind the user's back.
    if (!isDev && !persistedCoreSettings.controllerSecret) {
      persistedCoreSettings = await coreSettingsService.set({
        ...persistedCoreSettings,
        controllerSecret: randomSecret(32)
      })
    }
    const productionSecret = isDev ? null : persistedCoreSettings.controllerSecret
    // Listener ports are stable user settings rather than opportunistic free
    // ports. Before a production start, the reclaimer below takes them back from
    // whichever process currently owns them.
    const productionControllerPort = isDev ? null : persistedCoreSettings.controllerPort
    const productionControllerHost = isDev ? '127.0.0.1' as const : persistedCoreSettings.controllerHost
    const productionAllowLan = !isDev && persistedCoreSettings.allowLan
    const productionControllerPanel = !isDev && persistedCoreSettings.controllerPanel
    const productionMixedPort = isDev ? null : persistedCoreSettings.mixedPort
    const productionHttpPort = !isDev && persistedCoreSettings.httpPort !== 0
      ? persistedCoreSettings.httpPort
      : undefined
    const productionSocksPort = !isDev && persistedCoreSettings.socksPort !== 0
      ? persistedCoreSettings.socksPort
      : undefined
    const productionKernelRoot = join(profileRoot, 'kernel')
    /** Proxy guard cadence (clash-verge-rev defaults to 30s; keep the same). */
    const PROXY_GUARD_INTERVAL_MS = 30_000
    // Installer-shipped geodata databases (Layer 2): resolved relative to the app
    // resources so the packaged app can seed the kernel's persistent home. Empty
    // in dev, where the resources dir does not carry them (fail-open: the kernel
    // then falls back to its own download path exactly as before).
    const geodataSeedDir = isDev ? undefined : join(process.resourcesPath, 'geodata')
    // Hydrate before login-item and window behavior consume the synchronous mirror.
    // Warmed at module level; this resolves from the store's lazy queue.
    state.cachedAppSettings = await shell.appSettingsWarm
    const startupService = new StartupService(new ScheduledTaskStartupAdapter(() => state.cachedAppSettings.silentLaunch))
    const refreshStartupRegistration = (context: string): void => {
      void startupService.refreshRegistration()
        .then((status) => {
          if (status.phase === 'error') {
            console.warn(`[startup] ${context}:`, status.errorMessage ?? '系统未确认开机启动设置')
          }
        })
        .catch((error) => {
          console.warn(`[startup] ${context}:`, error)
        })
    }
    // One-shot registration maintenance at startup: migrates v0.9.x Run-key
    // login-item users to the scheduled task and rewrites stale `--hidden`
    // arguments. Best-effort and non-blocking; the toggle still works either way.
    refreshStartupRegistration('registration maintenance skipped')
    appSettingsService.onChange((settings) => {
      const silentLaunchChanged = settings.silentLaunch !== state.cachedAppSettings.silentLaunch
      state.cachedAppSettings = settings
      if (silentLaunchChanged) {
        refreshStartupRegistration('failed to refresh login-item arguments')
      }
      void state.subStoreServiceRef?.onSettings({
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
    const tunSupported = !isDev && process.platform === 'win32'
    const tunServiceClient = tunSupported
      ? new TunServiceClient(new NamedPipeTunServiceTransport(tunServiceIdentity(brand.appId).pipeName))
      : null
    let applyInstalledKernelVersionImpl: NonNullable<KernelManagerServiceDeps['applyInstalledVersion']> = async () => {
      throw new ProtocolError(ProtocolErrorCode.INTERNAL, '内核版本切换器尚未就绪')
    }
    const kernelManagerService = new KernelManagerService({
      settings: appSettingsService,
      workspaceRoot: productionKernelRoot,
      specificVersionsSupported: true,
      installVersion: tunServiceClient ? (version) => tunServiceClient.installVersion(version, productionMixedPort!) : undefined,
      applyInstalledVersion: (version, previous) => applyInstalledKernelVersionImpl(version, previous)
    })
    if (tunServiceClient) {
      profileService.setSemanticValidator(async (document) => {
        const dnsApplied = await dnsEnhancementService.applyToDocument(document)
        const enhanced = await snifferEnhancementService.applyToDocument(dnsApplied)
        const [core, geodata, tunConfig, selection] = await Promise.all([
          coreSettingsService.getRaw(),
          geodataSettingsService.getRaw(),
          tunConfigService.readConfig(),
          kernelManagerService.getVersionSelection()
        ])
        const runtime = {
          mixedPort: productionMixedPort!,
          httpPort: productionHttpPort,
          socksPort: productionSocksPort,
          controllerPort: productionControllerPort!,
          controllerHost: productionControllerHost,
          allowLan: productionAllowLan,
          controllerPanel: productionControllerPanel,
          secret: productionSecret!,
          device: `${brand.shortName} TUN`
        }
        const effective = generateProxiedTunConfig({
          ...runtime, document: enhanced, core, geodata, tunConfig, tunEnabled: true
        })
        const version = selection.channel === 'specific'
          ? selection.specificVersion ?? undefined
          : selection.channel === 'preview' || selection.channel === 'smart' ? selection.channel : undefined
        await tunServiceClient.validateProfile(effective, version)
        return { ok: true, issues: [] }
      })
    }
    // Windows production uses the installed LocalSystem service as the ONE core
    // host in both ordinary and TUN modes. The same client is also used by the
    // liveness monitor, so ownership cannot split across independent handles.
    const kernelSupervisor = new KernelSupervisor(
      {
        resolver: isDev
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
        configStore: isDev
          ? new TempKernelConfigStore()
          : new MihomoKernelConfigStore({
              mixedPort: productionMixedPort!,
              httpPort: productionHttpPort,
              socksPort: productionSocksPort,
              controllerPort: productionControllerPort!,
              controllerHost: productionControllerHost,
              allowLan: productionAllowLan,
              controllerPanel: productionControllerPanel,
              workspaceDir: join(productionKernelRoot, 'runtime'),
              // Stable kernel home (`-d`): mihomo resolves geodata databases and
              // provider caches here, so the directory must persist across runs.
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
        secret: isDev ? (process.env.MURGE_DEV_SECRET ?? '') : productionSecret!,
        // Job-Object equivalent (Windows production): if the app is killed while
        // the kernel lives, the watchdog force-kills the kernel tree so a dead
        // GUI never leaves an orphan holding the unified ports / TUN device.
        attachWatchdog: isDev || process.platform !== 'win32' ? undefined : (await import('../kernel/crash-watchdog')).attachKernelWatchdog
      },
      { readinessPattern: isDev ? /fixture-ready/ : null }
    )
    const privilegedKernel = tunSupported && !hasArg('--kernel-smoke')
      ? new PrivilegedServiceKernelGateway(
          tunServiceClient!,
          () => ({
            controllerPort: productionControllerPort!,
            controllerHost: productionControllerHost,
            allowLan: productionAllowLan,
            controllerPanel: productionControllerPanel,
            mixedPort: productionMixedPort!,
            httpPort: productionHttpPort,
            socksPort: productionSocksPort,
            secret: productionSecret!
          }),
          {
            readActiveDocument: resolveEnhancedActiveDocument,
            readTunConfig: () => tunConfigService.readConfig(),
            readCore: () => coreSettingsService.getRaw(),
            readGeodata: () => geodataSettingsService.getRaw()
          },
          {
            waitUntilReady: async ({ controllerPort, mixedPort, httpPort, socksPort, secret, pid, signal }) => {
              const client = new MihomoClient(`http://127.0.0.1:${controllerPort}`, secret, { timeoutMs: 750 })
              const expectedPorts = [mixedPort, httpPort, socksPort, controllerPort].filter(
                (port): port is number => port !== undefined
              )
              let lastFailure = 'controller did not respond'
              while (!signal.aborted) {
                try {
                  const version = await client.getVersion(signal)
                  const listenersOwned = process.platform !== 'win32' || await proxyPortsOwnedByPid(
                    expectedPorts,
                    pid
                  )
                  if (listenersOwned) return { version: version.version }
                  lastFailure = `ports ${expectedPorts.join(',')} are not all owned by core process ${pid}`
                } catch (error) {
                  lastFailure = error instanceof Error ? error.message : 'controller probe failed'
                  // Controller and listener ownership are retried together until
                  // the bounded startup deadline expires.
                }
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
              throw new ProtocolError(
                ProtocolErrorCode.KERNEL_START_TIMEOUT,
                `privileged mihomo did not become ready: ${lastFailure}`
              )
            }
          },
          `${brand.shortName} TUN`,
          // A cold protected service home may need to initialize provider caches.
          // Keep polling while the exact child remains alive; liveness monitoring
          // still fails immediately if it exits, so this is not a blind delay.
          60_000,
          () => kernelManagerService.isEnabled(),
          // The authenticated LocalSystem service performs atomic port takeover
          // immediately before spawning its pinned core.
          () => undefined,
          () => kernelManagerService.getVersionSelection()
        )
      : null
    // A service-owned core surviving an abnormal GUI exit may still own TUN
    // routes. It must be stopped before the durable intent replays a start, but
    // it does NOT gate window creation: the reconciliation runs after the window
    // exists, and the serialized mode queue keeps it ordered ahead of any
    // renderer-triggered kernel start (the renderer reads a stopped kernel until
    // it settles). A delayed Windows service start is handled by the gateway's
    // bounded start retry and runtime-intent recovery.
    const privilegedReconcile = (async (): Promise<void> => {
      if (!privilegedKernel) return
      await privilegedKernel.initialize().catch((error) => {
        console.warn('[kernel] privileged service startup reconciliation deferred:', error)
      })
    })()
    const kernelInstance: KernelGateway = privilegedKernel ?? kernelSupervisor
    state.kernel = kernelInstance
    // Await the (mock or disabled) controller gateway before wiring IPC so the
    // renderer's first pull always sees a live controller in dev.
    const gateway = await createMihomoGateway(
      isDev
        ? undefined
        : {
            url: `http://127.0.0.1:${productionControllerPort}`,
            secret: productionSecret!
          },
      async () => parseProxyGroupTestUrls((await resolveEnhancedActiveDocument()) ?? ''),
      async () => {
        const settings = await appSettingsService.get()
        return { scope: settings.delayTestUrlScope, url: settings.delayTestUrl }
      },
      (message) => fileLogs.writeCore(message)
    )
    const ipcKernel = !isDev && state.mihomo
      ? new ControllerReadyKernelGateway(
          kernelInstance,
          new MihomoClient(`http://127.0.0.1:${productionControllerPort}`, productionSecret!, { timeoutMs: 750 })
        )
      : kernelInstance

    // CI-only installed-artifact probe. Unlike --packaging-smoke, this exercises
    // the complete opt-in production path: bundled archive verification,
    // extraction, process spawn, authenticated /version readiness and cleanup.
    if (!isDev && hasArg('--kernel-smoke')) {
      const started = await ipcKernel.start()
      if (started.phase !== 'running') {
        throw new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, 'Packaged kernel did not reach running state')
      }
      await ipcKernel.stop()
      console.log('[kernel-smoke] bundled kernel lifecycle: PASS')
      app.quit()
      return
    }

    // CI-only installed-artifact probe: headless per-user HKCU proxy enable for
    // the package-win job (double-gated inside the probe).
    if (!isDev && hasArg('--system-proxy-enable')) {
      await runSystemProxyEnable(ipcKernel, gateway as unknown as LiveProbeMihomo)
      return
    }

    // System-proxy controller (probe reads the LIVE mixed port; single-kernel view).
    let singleKernelGatewayRef: KernelGateway | null = null
    const singleKernelProbeGateway = new LateBoundKernelGateway(() => singleKernelGatewayRef)
    const systemProxyService = createSystemProxy({
      appDataBase: app.getPath('appData'),
      isDev,
      kernel: ipcKernel,
      mihomo: gateway,
      // In single-kernel mode the system proxy simply points at the one unified
      // mixed-port, whatever host is live, so the live probe needs nothing beyond
      // the unified kernel + controller. On non-Windows the platform adapter is
      // unsupported and the factory's default probe is used.
      probe: isDev
        ? undefined
        : process.platform === 'win32'
          ? new LiveSystemProxyKernelProbe(singleKernelProbeGateway, gateway)
          : undefined
    })
    state.systemProxy = systemProxyService
    // Orphan recovery reads the backup and possibly the registry (reg.exe). It
    // must complete before the proxy may be enabled and before the runtime intent
    // replays, but it never gates window creation: until it settles the service
    // reports its initial (disabled) phase and the renderer shows that state.
    const systemProxyInit = systemProxyService.init().catch((error) => {
      console.error('[system-proxy] orphan recovery failed:', error)
    })

    // Order the proxy restore ahead of kernel shutdown: a user stop restores the
    // system proxy first and aborts the stop if that restoration genuinely fails,
    // so the proxy never points at a dead port.
    const orderedKernel = new SystemProxyOrderedKernelGateway(ipcKernel, systemProxyService)

    // Crash the controller while the proxy was owned: restore immediately, then
    // wake the durable-intent recovery coordinator (never a cached crash-time
    // boolean — the user may have switched the proxy off during recovery).
    orderedKernel.onStatus((status) => {
      if (status.phase === 'failed') {
        void systemProxyService.restoreBeforeKernelUnavailable().catch((error) => {
          console.error('[system-proxy] kernel crash recovery failed:', error)
        }).finally(() => state.runtimeIntentRecovery?.wake())
      }
    })

    // Proxy guard (clash-verge-rev's guard loop on this app's ownership model).
    state.proxyGuardTimer = setInterval(() => {
      if (!state.cachedAppSettings.proxyGuard) return
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
            controllerHost: productionControllerHost,
            allowLan: productionAllowLan,
            controllerPanel: productionControllerPanel,
            mixedPort: productionMixedPort!,
            httpPort: productionHttpPort,
            socksPort: productionSocksPort,
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
          // module enabled.
          async () => documentDnsEnabled(await resolveEnhancedActiveDocument())
        )
      : new GatedTunMutationAdapter()
    const tunInstance = new TunCoordinator(tunAdapter, tunSupported)
    state.tunCoordinator = tunInstance
    // TUN transaction reconciliation is deliberately ordered AFTER the
    // privileged-kernel stop (see privilegedReconcile).
    const tunReconcile = (async (): Promise<void> => {
      if (!tunSupported) return
      await tunInstance.initialize().catch((error) => {
        console.error('[tun] service reconciliation failed:', error)
      })
    })()
    // Recovery layers joined in order: orphaned proxy backup -> stale service core
    // stop -> TUN transaction reconcile. The runtime intent replay and the CI
    // hidden-start smoke both await this before touching the kernel.
    const recoverManagedState = systemProxyInit
      .then(() => privilegedReconcile)
      .then(() => tunReconcile)
    // One mode-transition queue for EVERY host switch (kernel start/stop, TUN
    // enable/disable, failure recovery).
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
    // unsupported/dev platforms this remains the ordinary ordered gateway.
    const runtimeKernelGateway = orderedKernel
    // Bind the system-proxy probe's holder to the unified gateway once it exists.
    singleKernelGatewayRef = runtimeKernelGateway

    const modeController = new ModeTransitionController({
      kernel: runtimeKernelGateway,
      tun: rawTunGateway,
      systemProxy: systemProxyService,
      strategy: tunSupported ? 'in-place' : 'host-handoff',
      onError: (error, step) => console.error(`[mode-transition] ${step}:`, error)
    })
    const applyInstalledKernelVersionFinal = async (version: string, previous: { channel: KernelVersionChannel; specificVersion: string | null }): Promise<void> => {
      const before = await runtimeKernelGateway.getStatus()
      if (before.phase !== 'running' && before.phase !== 'starting') return
      const rollback = async (): Promise<void> => {
        await appSettingsService.set({
          kernelChannel: previous.channel,
          kernelSpecificVersion: previous.specificVersion ?? ''
        })
      }
      await modeController.reloadProfile((kernel) =>
        reloadKernelForActiveProfile({ kernel, systemProxy: systemProxyService }, { rollbackActive: rollback })
      )
      const applied = await runtimeKernelGateway.getStatus()
      if (/^v\d+\.\d+\.\d+$/.test(version) && applied.version?.replace(/^v/, '') !== version.replace(/^v/, '')) {
        await rollback()
        await modeController.reloadProfile((kernel) =>
          reloadKernelForActiveProfile({ kernel, systemProxy: systemProxyService })
        ).catch(() => undefined)
        throw new ProtocolError(
          ProtocolErrorCode.ARTIFACT_HASH_MISMATCH,
          `内核版本未生效：请求 ${version}，实际 ${applied.version ?? '未知'}`
        )
      }
    }
    applyInstalledKernelVersionImpl = applyInstalledKernelVersionFinal
    state.modeTransition = modeController
    // The IPC-facing gateways go through THE ONE mode-transition queue.
    const queuedKernel = queuedKernelGateway(runtimeKernelGateway, modeController)
    const queuedTun = queuedTunGateway(rawTunGateway, modeController)

    // The service owns the only process, so monitor it regardless of TUN state.
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
              state.runtimeIntentRecovery?.wake()
            }
          })
          .catch((error) => console.error('[kernel] privileged service liveness probe failed:', error))
          .finally(() => { probingPrivilegedKernel = false })
      }, 5_000)
      state.tunExitMonitor = { stop: () => clearInterval(monitor) }
    }

    // Connectivity watchdog: offline -> restore owned proxy/TUN + stop host;
    // online -> replay the remembered run mode. Lives after `queuedKernel`.
    state.networkDetector = new NetworkDetector({
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
            state.runtimeIntentRecovery?.wake()
          }
        }
      }
    })
    // A resume must not wait for the next periodic tick to reconcile.
    powerMonitor.on('resume', () => {
      void state.networkDetector?.probeNow()
        .catch((error) => {
          console.error('[network-detector] resume probe failed:', error)
        })
        .finally(() => state.runtimeIntentRecovery?.wake())
    })
    // `session-end` is the most direct Windows signal; the application-level
    // shutdown event is an independent best-effort entry point. The shared
    // shutdownPromise makes both signals idempotent.
    powerMonitor.on('shutdown', () => {
      void lifecycle.beginApplicationShutdown(true)
    })

    // Reapply active-profile mutations through the controller first; a failed
    // controller reload falls back to the full lifecycle path.
    let liveConfigReloader: LiveConfigReloader | null = null
    const profileGateway = new ProfileAutoReloadGateway({
      inner: profileService,
      autoActivateOnEdit: true,
      reloader: {
        reload: async (rollbackActive) => {
          if (liveConfigReloader) {
            let applied: boolean | null = null
            try {
              applied = await modeController.updateRuntimeConfig(() =>
                liveConfigReloader!.reloadIfRunning()
              )
            } catch (error) {
              console.warn('[profiles] hot reload failed; falling back to kernel restart:', error)
            }
            if (applied !== null) {
              if (applied) await proxySelectionService.restoreSelections()
              return
            }
          }
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
    state.waitForProfileOperations = () => profileGateway.waitForIdle()
    // Per-profile node-pick cache (sparkle/clash-party model).
    const proxySelectionService = new ProxySelectionService(
      gateway,
      profileGateway,
      proxySelectionStore
    )
    liveConfigReloader = isDev
      ? null
      : new LiveConfigReloader(
          runtimeKernelGateway,
          gateway,
          {
            mixedPort: productionMixedPort!,
            httpPort: productionHttpPort,
            socksPort: productionSocksPort,
            controllerPort: productionControllerPort!,
            controllerHost: productionControllerHost,
            allowLan: productionAllowLan,
            controllerPanel: productionControllerPanel,
            secret: productionSecret!,
            device: `${brand.shortName} TUN`
          },
          {
            readActiveDocument: resolveEnhancedActiveDocument,
            readTunConfig: () => tunConfigService.readConfig(),
            readCore: () => coreSettingsService.getRaw(),
            readGeodata: () => geodataSettingsService.getRaw()
          }
        )
    const runEnhancementUpdate = <T>(operation: () => Promise<T>): Promise<T> =>
      modeController.updateRuntimeConfig(operation)
    const dnsEnhancementCoordinator = new EnhancementApplyCoordinator(
      runEnhancementUpdate,
      async () => { await liveConfigReloader?.patchSectionsIfRunning(['dns']) }
    )
    const snifferEnhancementCoordinator = new EnhancementApplyCoordinator(
      runEnhancementUpdate,
      async () => { await liveConfigReloader?.patchSectionsIfRunning(['sniffer']) }
    )
    const geodataEnhancementCoordinator = new EnhancementApplyCoordinator(
      runEnhancementUpdate,
      async () => { await liveConfigReloader?.patchSectionsIfRunning(['geodata']) }
    )
    const liveDnsEnhancement = new LiveDnsEnhancementGateway(dnsEnhancementService, dnsEnhancementCoordinator)
    const liveSnifferEnhancement = new LiveSnifferEnhancementGateway(snifferEnhancementService, snifferEnhancementCoordinator)
    const liveGeodataSettings = new LiveGeodataSettingsGateway(geodataSettingsService, geodataEnhancementCoordinator)
    const updates = new UpdateService(new ElectronUpdaterDriver(() => windowAdapter.showMainWindowAt('/about')))
    bindUpdateService(state, updates)
    updates.start()
    // Poll the feed while the app runs so a Release published mid-session is
    // picked up without waiting for the next launch (10-minute cadence).
    updates.startPolling()
    const usageHistoryService = new UsageHistoryService({
      store: app.isPackaged
        ? FileSystemUsageHistoryStore.forAppDataBase(app.getPath('appData'))
        : new InMemoryUsageHistoryStore(),
      onTraffic: (listener) => gateway.onTraffic(listener),
      onConnections: (listener) => gateway.onConnections(listener),
      onError: (error) => console.error('[usage-history] background persistence failed:', error)
    })
    // Sub-Store is a first-class item in the 配置 sidebar group. New installs
    // default it on and prepare the verified assets in the background.
    const subStoreService = new SubStoreService({
      baseDir: join(appDataRoot(app.getPath('appData')), 'substore'),
      brandName: brand.productName,
      getMixedPort: () => productionMixedPort,
      appSettings: appSettingsService,
      onLog: (stream, text) => { void fileLogs.writeSubStore(stream, text).catch(() => undefined) }
    })
    state.subStoreServiceRef = subStoreService
    // Bounded local-file work that the renderer reads over IPC, run concurrently
    // ahead of IPC registration.
    await Promise.all([
      usageHistoryService.init(),
      subStoreService.onSettings({
        subStoreEnabled: state.cachedAppSettings.subStoreEnabled,
        subStoreUseProxy: state.cachedAppSettings.subStoreUseProxy
      }).then(() => {
        if (state.cachedAppSettings.subStoreEnabled) {
          void subStoreService.ensureRunning().catch((error) => {
            console.error('[substore] default asset preparation failed:', error)
          })
        }
      })
    ])
    state.usageHistoryServiceRef = usageHistoryService
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
    // INTERNET-latency card: gateway RTT + kernel DNS + selected-node chain RTT.
    const internetLatencyService = new InternetLatencyService({
      mihomo: gateway,
      resolveGroupOrder: async () => {
        const active = await profileService.getActiveProfile()
        return active ? parseProxyGroupOrder(active.document) : []
      }
    })
    // 解锁测试 probes go through the kernel's LIVE mixed port (kernel down fails
    // closed instead of sampling DIRECT).
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
    const selectionGateway = new ProxySelectionGateway(
      gateway,
      proxySelectionService,
      (operation) => profileGateway.runExclusive(operation)
    )
    const remoteIconCache = new RemoteIconCache(
      join(app.getPath('userData'), 'icon-cache'),
      [async (url, init) => {
        const response = await globalThis.fetch(url, init as RequestInit)
        return {
          ok: response.ok,
          status: response.status,
          url: response.url,
          headers: response.headers,
          text: () => response.text(),
          body: response.body ?? undefined
        }
      }, createSubscriptionProxyFetchFn()]
    )
    state.disposeIpc = registerIpc({
      internetLatency: internetLatencyService,
      unlock: serviceUnlockService,
      kernel: queuedKernel,
      kernelManager: kernelManagerService,
      // The selection-recording wrapper is what the renderer talks to.
      mihomo: selectionGateway,
      profiles: profileGateway,
      systemProxy: systemProxyService,
      startup: startupService,
      appSettings: appSettingsService,
      overrides: overrideService,
      dns: liveDnsEnhancement,
      sniffer: liveSnifferEnhancement,
      tunConfig: tunConfigService,
      core: coreSettingsService,
      geodata: liveGeodataSettings,
      updates,
      tun: queuedTun,
      usageHistory: usageHistoryService,
      networkMetadata: networkMetadataService,
      subStore: subStoreService,
      resolveActiveGroupOrder: async () =>
        parseProxyGroupOrder((await resolveEnhancedActiveDocument()) ?? ''),
      resolveActiveProviderCatalog: async () =>
        parseProviderCatalog((await resolveEnhancedActiveDocument()) ?? ''),
      resolveProviderContent: tunServiceClient
        ? (kind, name) => tunServiceClient.getProviderContent(kind, name)
        : undefined,
      resolveActiveConfigInspection: async () => {
        const profile = await profileService.getActiveProfile()
        if (!profile) return inspectActiveProfileConfig(null, '', '', {
          coreOverride: false, dnsOverride: false, snifferOverride: false,
          geodataOverride: false, tunEnabled: false
        })
        const [enhanced, core, geodata, tunConfig, dnsSnapshot, snifferSnapshot] = await Promise.all([
          resolveEnhancedActiveDocument(),
          coreSettingsService.getRaw(),
          geodataSettingsService.getRaw(),
          tunConfigService.readConfig(),
          dnsEnhancementService.get(),
          snifferEnhancementService.get()
        ])
        const tunPhase = tunInstance.getStatus().phase
        const tunEnabled = tunPhase === 'active' || tunPhase === 'starting' || tunPhase === 'restoring'
        const runtime = {
          mixedPort: productionMixedPort ?? 7890,
          httpPort: productionHttpPort,
          socksPort: productionSocksPort,
          controllerPort: productionControllerPort ?? 9090,
          controllerHost: productionControllerHost,
          allowLan: productionAllowLan,
          controllerPanel: productionControllerPanel,
          secret: productionSecret ?? '0'.repeat(64),
          device: `${brand.shortName} TUN`
        }
        const base = enhanced ?? profile.document
        const effective = tunEnabled
          ? generateProxiedTunConfig({ ...runtime, document: base, core, geodata, tunConfig, tunEnabled: true })
          : buildProfileKernelConfig(base, { ...runtime, core, geodata })
        return inspectActiveProfileConfig(profile.meta.name, profile.document, effective, {
          coreOverride: core.enabled,
          dnsOverride: dnsSnapshot.enhancement.enabled,
          snifferOverride: snifferSnapshot.enhancement.enabled,
          geodataOverride: geodata.enabled,
          tunEnabled
        })
      },
      remoteIconCache
    })
    windowAdapter.createWindow()

    // Tray: construction + wiring moved to the tray adapter (same dependencies).
    const tray: TrayAdapter = createTrayAdapter({
      state,
      kernel: queuedKernel,
      mihomo: selectionGateway,
      profiles: profileGateway,
      systemProxy: systemProxyService,
      tun: queuedTun,
      internetLatency: internetLatencyService,
      resolveGroupOrder: async () => parseProxyGroupOrder((await resolveEnhancedActiveDocument()) ?? ''),
      resolveGroupIcon: (cacheKey, url, refresh) => remoteIconCache.get(cacheKey, url, refresh),
      reloadConfig: () => modeController.updateRuntimeConfig(async () => {
        if (!liveConfigReloader) return
        if (await liveConfigReloader.reloadIfRunning()) await proxySelectionService.restoreSelections()
      }),
      restartKernel: async () => {
        await modeController.reloadProfile((kernel) =>
          reloadKernelForActiveProfile({ kernel, systemProxy: systemProxyService })
        )
        await proxySelectionService.restoreSelections()
      },
      showWindow: () => windowAdapter.showMainWindow(),
      quit: () => app.quit(),
      tunStatusPhase: () => tunInstance.getStatus().phase,
      kernelRoot: productionKernelRoot,
      logDirectory: shell.logDirectory,
      onCheckUpdate: () => { void updates.check().catch((error) => console.warn('[updates] tray check failed:', error)) },
      onError: (error) => console.error('[tray] kernel action failed:', error)
    }, { isDev })
    // Tray initialization no longer gates the startup chain.
    const trayReady = tray.initialize()

    // Tray/runtime accent follows proxy/TUN phases + native theme.
    const unsubscribeProxyAppearance = systemProxyService.onStatus(() => tray.updateRuntimeAppearance())
    const unsubscribeTunAppearance = tunInstance.onStatus(() => tray.updateRuntimeAppearance())
    state.disposeRuntimeAppearance = tray.attachAppearanceListeners(
      unsubscribeProxyAppearance,
      unsubscribeTunAppearance
    )
    tray.updateRuntimeAppearance()

    // CI-only installed-artifact proof for the real login-launch shape.
    if (!isDev && hasArg('--hidden-smoke')) {
      await Promise.all([recoverManagedState, trayReady])
      if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.MURGE_CI_HIDDEN_START !== '1') {
        throw new Error('--hidden-smoke is restricted to the packaged GitHub Actions Windows probe')
      }
      const window = state.mainWindow
      const status = await orderedKernel.getStatus()
      if (!launchHidden || !window || window.isDestroyed() || window.isVisible()) {
        throw new Error('hidden startup created a missing, destroyed, or visible main window')
      }
      if (!tray.isReady()) throw new Error('hidden startup did not create a live native tray')
      if (status.phase !== 'stopped' || status.pid !== null) {
        throw new Error(`hidden startup unexpectedly activated the kernel (${status.phase}, pid=${status.pid ?? 'none'})`)
      }
      console.log('[hidden-smoke] hidden window + native tray + stopped kernel: PASS')
      app.exit(0)
      return
    }

    // Restore the user's last requested networking state after the deferred
    // recovery layers complete. Login launches use `--hidden`, but must still
    // restore the requested state; only the explicit Actions smoke flag
    // suppresses it. Operations are sequential and bounded.
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
        await recoverManagedState
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
      state.runtimeIntentRecovery = new RuntimeIntentRecoveryCoordinator({
        settings: appSettingsService,
        restore: runtimeIntentDeps,
        log: (message, error) => console.warn(message, error ?? '')
      })
      state.runtimeIntentRecovery.start()
    }

    // Arm connectivity recovery only after startup reconciliation.
    state.networkDetector.start()

    // Auto-check for a newer release on launch, gated on the persisted
    // "启动时自动检查更新" setting. Wrapped so a transient network failure only
    // logs and never blocks startup.
    if (!isDev) {
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
      windowAdapter.showMainWindow()
    })
  }

  /** Local controller-gateway builder (verbatim; state assigned inside). */
  async function createMihomoGateway(
    productionController?: { url: string; secret: string },
    resolveGroupTestUrls?: () => Promise<Record<string, string | null>>,
    resolveDelayTestSettings?: () => Promise<{ scope: 'group' | 'global'; url: string }>,
    logSink?: (message: MihomoLogMessage) => void | Promise<void>
  ): Promise<MihomoGateway> {
    if (isDev) {
      const secret = process.env.MURGE_DEV_SECRET || 'dev-mock-secret'
      const mockServer = await startMockMihomoServer({ secret })
      state.mockServer = mockServer
      const client = new MihomoClient(mockServer.baseUrl, secret)
      state.mihomo = new MihomoService(client, {
        wsBaseUrl: mockServer.wsBaseUrl,
        secret,
        enabled: true,
        resolveGroupTestUrls,
        resolveDelayTestSettings,
        logSink
      })
    } else {
      if (!productionController) {
        throw new ProtocolError(ProtocolErrorCode.INTERNAL, 'Production controller configuration is missing')
      }
      const client = new MihomoClient(productionController.url, productionController.secret)
      state.mihomo = new MihomoService(
        client,
        {
          wsBaseUrl: productionController.url.replace(/^http/, 'ws'),
          secret: productionController.secret,
          enabled: true,
          resolveGroupTestUrls,
          resolveDelayTestSettings,
          logSink
        }
      )
    }
    return state.mihomo
  }
}
