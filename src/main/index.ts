import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { brand } from '@shared/brand'
import { parseBrandConfig } from '@shared/schemas/brand'
import { migrateLegacyAppData, appDataRoot, resolveRuntimeProfileRoot } from './storage/app-data'
import { registerIpc } from './ipc/register-ipc'
import { KernelSupervisor } from './kernel/supervisor'
import { createKernelResolver } from './kernel/resolvers'
import { TempKernelConfigStore } from './kernel/config-store'
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

const controllerUrl = process.env.MURGE_DEV_CONTROLLER ?? 'http://127.0.0.1:9090'
const controllerSecret = process.env.MURGE_DEV_SECRET ?? ''

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
 * network change. Production keeps the REST surface but leaves push streams
 * closed: a real controller is a later, opt-in milestone.
 */
async function createMihomoGateway(): Promise<MihomoGateway> {
  if (is.dev) {
    const secret = controllerSecret || 'dev-mock-secret'
    mockServer = await startMockMihomoServer({ secret })
    const client = new MihomoClient(mockServer.baseUrl, secret)
    mihomo = new MihomoService(client, { wsBaseUrl: mockServer.wsBaseUrl, secret, enabled: true })
  } else {
    const client = new MihomoClient(controllerUrl, controllerSecret)
    mihomo = new MihomoService(
      client,
      { wsBaseUrl: controllerUrl.replace(/^http/, 'ws'), secret: controllerSecret, enabled: false }
    )
  }
  return mihomo
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1120,
    height: 806,
    minWidth: 934,
    minHeight: 672,
    show: false,
    autoHideMenuBar: true,
    title: brand.productName,
    backgroundColor: '#eef3f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
    const window = BrowserWindow.getAllWindows()[0]
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

  // Development/builds always use the harmless fixture process; a real kernel
  // is never resolved or executed until a later milestone enables it opt-in.
  const kernelInstance = new KernelSupervisor(
    {
      resolver: createKernelResolver({ appPath: app.getAppPath(), mode: is.dev ? 'fixture' : 'disabled' }),
      configStore: new TempKernelConfigStore(),
      adapter: new NodeKernelProcessAdapter(),
      secret: controllerSecret
    },
    { readinessPattern: /fixture-ready/ }
  )
  kernel = kernelInstance
  // Await the (mock or disabled) controller gateway before wiring IPC so the
  // renderer's first pull always sees a live controller in dev.
  const gateway = await createMihomoGateway()
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
    kernel: kernelInstance,
    mihomo: gateway,
    profiles: profileService
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
