import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { TrayMenuItem, TrayView } from './tray-controller'
import { createRuntimeIcon } from './runtime-icon'

export function createElectronTray(iconRoot: string, dark = false): TrayView {
  const tray = new Tray(createRuntimeIcon(iconRoot, 'idle', dark))
  let menu = Menu.buildFromTemplate([])
  return {
    isReady: () => !tray.isDestroyed(),
    setToolTip: (value) => tray.setToolTip(value),
    setMenu: (items) => {
      const menuIcon = (value?: string) => {
        if (!value?.startsWith('data:image/') || value.length > 512_000) return undefined
        const image = nativeImage.createFromDataURL(value)
        return image.isEmpty() ? undefined : image.resize({ width: 16, height: 16, quality: 'best' })
      }
      const toTemplate = (item: TrayMenuItem): MenuItemConstructorOptions => item.type === 'separator'
        ? { type: 'separator' }
        : {
            label: item.label,
            icon: menuIcon(item.icon),
            enabled: item.enabled,
            type: item.type,
            checked: item.checked,
            submenu: item.submenu?.map(toTemplate),
            click: item.click
          }
      menu = Menu.buildFromTemplate(items.map(toTemplate))
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
    onMenuOpen: (listener) => {
      let opening = false
      const open = (): void => {
        if (opening) return
        opening = true
        void listener()
          .catch(() => undefined)
          .finally(() => {
            if (!tray.isDestroyed()) tray.popUpContextMenu(menu)
            opening = false
          })
      }
      tray.on('right-click', open)
      return () => tray.removeListener('right-click', open)
    },
    destroy: () => tray.destroy()
  }
}
