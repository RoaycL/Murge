import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, net, Notification } from 'electron'
import { brand } from '@shared/brand'
import { ElectronUpdaterDriver } from './electron-updater-driver'
import { SignedManifestUpdaterDriver } from './signed-manifest-driver'
import { UPDATE_PUBLIC_KEY } from './update-public-key'
import type { UpdaterDriver } from './updater-driver'

/** Mirrors tried alongside direct GitHub (the electron-updater driver's list). */
const GITHUB_PROXIES: readonly string[] = ['https://gh-proxy.org', 'https://ghfast.top']

/**
 * Pick the production update driver. With a pinned release key the build
 * follows the signed manifest (and so moves to the Tauri build); without one
 * it keeps electron-updater.
 */
export function createUpdaterDriver(onNotificationClick: () => void): UpdaterDriver {
  if (!UPDATE_PUBLIC_KEY.trim()) return new ElectronUpdaterDriver(onNotificationClick)
  const path = new URL(brand.repositoryUrl).pathname.replace(/^\/+|\/+$/g, '')
  const [owner = '', repo = ''] = path.split('/')
  const directBase = `https://github.com/${owner}/${repo}/releases/latest/download`
  const notifications = new Set<Notification>()
  return new SignedManifestUpdaterDriver({
    currentVersion: app.getVersion(),
    supported: app.isPackaged && process.platform === 'win32',
    arch: process.arch,
    publicKey: UPDATE_PUBLIC_KEY,
    feedBases: [directBase, ...GITHUB_PROXIES.map((proxy) => `${proxy}/${directBase}`)],
    directBase,
    fetch: (url, init) => net.fetch(url, { signal: init.signal, cache: 'no-store' }),
    downloadDir: join(app.getPath('temp'), `${brand.executableName}-update`),
    writeFile: async (file, data) => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, data)
    },
    launchInstaller: (file, args) => {
      // ShellExecute (via Start-Process) so the per-machine installer can
      // raise its own UAC prompt; a plain CreateProcess cannot elevate. The
      // path travels in the environment, never through command-line quoting.
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const argumentList = args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(',')
      const child = spawn(
        powershell,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath $env:UPDATE_INSTALLER_PATH -ArgumentList ${argumentList}`],
        { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, UPDATE_INSTALLER_PATH: file } }
      )
      child.unref()
    },
    requestQuit: () => app.quit(),
    notify: (title, body) => {
      try {
        if (!Notification.isSupported()) return
        const notification = new Notification({ title, body })
        notifications.add(notification)
        const release = (): void => { notifications.delete(notification) }
        notification.once('click', () => {
          release()
          onNotificationClick()
        })
        notification.once('close', release)
        notification.show()
      } catch {
        // A failing notification must never take down the updater event stream.
      }
    }
  })
}
