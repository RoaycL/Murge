import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { TrayMenuItem, TrayView } from './tray-controller'

export function createElectronTray(iconPath: string): TrayView {
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) throw new Error(`Tray icon could not be loaded: ${iconPath}`)
  const tray = new Tray(image.resize({ width: 16, height: 16 }))
  return {
    isReady: () => !tray.isDestroyed(),
    setToolTip: (value) => tray.setToolTip(value),
    setMenu: (items) => {
      const template = items.map((item): MenuItemConstructorOptions => item.type === 'separator'
        ? { type: 'separator' }
        : { label: item.label, enabled: item.enabled, click: item.click })
      tray.setContextMenu(Menu.buildFromTemplate(template))
    },
    onActivate: (listener) => {
      tray.on('click', listener)
      tray.on('double-click', listener)
      return () => {
        tray.removeListener('click', listener)
        tray.removeListener('double-click', listener)
      }
    },
    destroy: () => tray.destroy()
  }
}
