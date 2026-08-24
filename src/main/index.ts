import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { brand } from '@shared/brand'
import { parseBrandConfig } from '@shared/schemas/brand'
import { registerIpc } from './ipc/register-ipc'
import { KernelSupervisor } from './kernel/supervisor'
import { createKernelResolver } from './kernel/resolvers'
import { TempKernelConfigStore } from './kernel/config-store'
import { NodeKernelProcessAdapter } from './kernel/node-adapter'
import { MihomoClient } from './services/mihomo-client'
import { MihomoService } from './services/mihomo-service'
import { startMockMihomoServer, type MockMihomoServerHandle } from './testing/mock-mihomo-server'
import type { MihomoGateway } from '@shared/gateways'

const controllerUrl = process.env.MURGE_DEV_CONTROLLER ?? 'http://127.0.0.1:9090'
const controllerSecret = process.env.MURGE_DEV_SECRET ?? ''

// Created inside app.whenReady; held here so the quit path can stop it.
let kernel: KernelSupervisor | null = null
let mihomo: MihomoService | null = null
let mockServer: MockMihomoServerHandle | null = null
let isQuitting = false

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

app.whenReady().then(async () => {
  try {
    parseBrandConfig(brand)
  } catch (error) {
    console.error('[brand] invalid brand configuration:', error)
    app.exit(1)
    return
  }

  app.setName(brand.productName)
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
  registerIpc({
    kernel: kernelInstance,
    mihomo: gateway
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
      mihomo?.dispose()
      await mockServer?.close()
    } catch (error) {
      console.error('[mihomo] failed to stop mock controller during quit:', error)
    }
    app.quit()
  })()
})
