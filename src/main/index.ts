import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { brand } from '@shared/brand'
import { parseBrandConfig } from '@shared/schemas/brand'
import { registerIpc } from './ipc/register-ipc'
import { KernelSupervisor } from './services/kernel-supervisor'
import { MihomoClient } from './services/mihomo-client'

const controllerUrl = process.env.MURGE_DEV_CONTROLLER ?? 'http://127.0.0.1:9090'
const controllerSecret = process.env.MURGE_DEV_SECRET ?? ''

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
  registerIpc({
    kernel: new KernelSupervisor(),
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
