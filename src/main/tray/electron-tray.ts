import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import type { TrayMenuItem, TrayView } from './tray-controller'
import { createRuntimeIcon } from './runtime-icon'

export function createElectronTray(iconRoot: string, dark = false): TrayView {
  const tray = new Tray(createRuntimeIcon(iconRoot, 'idle', dark))
  return {
    isReady: () => !tray.isDestroyed(),
    setToolTip: (value) => tray.setToolTip(value),
    setMenu: (items) => {
      const template = items.map((item): MenuItemConstructorOptions => item.type === 'separator'
        ? { type: 'separator' }
        : { label: item.label, enabled: item.enabled, click: item.click })
      tray.setContextMenu(Menu.buildFromTemplate(template))
    },
    setRuntimeAppearance: (accent, nextDark) => {
      tray.setImage(createRuntimeIcon(iconRoot, accent, nextDark))
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
