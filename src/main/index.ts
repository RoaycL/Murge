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

const controllerUrl = process.env.MURGE_DEV_CONTROLLER ?? 'http://127.0.0.1:9090'
const controllerSecret = process.env.MURGE_DEV_SECRET ?? ''

// Created inside app.whenReady; held here so the quit path can stop it.
let kernel: KernelSupervisor | null = null
let isQuitting = false

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

app.whenReady().then(() => {
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
  registerIpc({
    kernel: kernelInstance,
    mihomo: new MihomoClient(controllerUrl, controllerSecret)
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
    app.quit()
  })()
})
