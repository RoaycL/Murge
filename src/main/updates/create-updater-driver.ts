import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, net, Notification } from 'electron'
import { brand } from '@shared/brand'
import { ElectronUpdaterDriver } from './electron-updater-driver'
import { SignedManifestUpdaterDriver } from './signed-manifest-driver'
import type { UpdaterDriver } from './updater-driver'
import type { UpdateChannel } from '@shared/app-settings'

/** Mirrors tried alongside direct GitHub (the electron-updater driver's list). */
const GITHUB_PROXIES: readonly string[] = ['https://gh-proxy.org', 'https://ghfast.top']

/**
 * Pick the production update driver. With a release key pinned in
 * `brand.config.json` (`updatePublicKey`) the build follows the signed
 * release-channel manifests (stable = Electron, experimental = Tauri);
 * without one it keeps electron-updater.
 */
export function createUpdaterDriver(onNotificationClick: () => void, channel: UpdateChannel): UpdaterDriver {
  const publicKey = brand.updatePublicKey?.trim() ?? ''
  if (!publicKey) return new ElectronUpdaterDriver(onNotificationClick)
  const path = new URL(brand.repositoryUrl).pathname.replace(/^\/+|\/+$/g, '')
  const [owner = '', repo = ''] = path.split('/')
  const notifications = new Set<Notification>()
  const downloadDir = join(app.getPath('temp'), `${brand.executableName}-update`)
  const failureFile = join(downloadDir, 'install-failure.txt')
  reportPreviousInstallFailure(failureFile)
  return new SignedManifestUpdaterDriver({
    currentVersion: app.getVersion(),
    supported: app.isPackaged && process.platform === 'win32',
    arch: process.arch,
    publicKey,
    product: 'electron',
    repositoryUrl: `https://github.com/${owner}/${repo}`,
    mirrors: GITHUB_PROXIES,
    channel,
    fetch: (url, init) => net.fetch(url, { signal: init.signal, cache: 'no-store' }),
    downloadDir,
    writeFile: async (file, data) => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, data)
    },
    readFile: (file) => readFileSync(file),
    launchInstaller: (file, args) => {
      // ShellExecute (via Start-Process) so the per-machine installer can
      // raise its own UAC prompt; a plain CreateProcess cannot elevate. The
      // path travels in the environment, never through command-line quoting.
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const argumentList = args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(',')
      // The helper waits for this process to exit first: the quit flow still
      // has cleanup to run, and the installer's running-app check would
      // otherwise find (and stop) a half-closed Electron process.
      const command = [
        'Wait-Process -Id ([int]$env:UPDATE_PARENT_PID) -Timeout 60 -ErrorAction SilentlyContinue',
        // A refused UAC prompt or a blocked file fails here, after this
        // process is gone: leave the reason for the next launch to log.
        `try { Start-Process -FilePath $env:UPDATE_INSTALLER_PATH -ArgumentList ${argumentList} -ErrorAction Stop } ` +
          'catch { Set-Content -LiteralPath $env:UPDATE_FAILURE_PATH -Value $_.Exception.Message -Encoding UTF8 }'
      ].join('; ')
      const child = spawn(
        powershell,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, UPDATE_INSTALLER_PATH: file, UPDATE_FAILURE_PATH: failureFile, UPDATE_PARENT_PID: String(process.pid) }
        }
      )
      child.once('error', (error) => console.error('[updates] failed to start the installer helper:', error))
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

/** Log (once) why the installer launched at the previous quit did not start. */
function reportPreviousInstallFailure(file: string): void {
  let reason: string
  try {
    reason = readFileSync(file, 'utf8').trim()
  } catch {
    return
  }
  console.error(`[updates] the update installer did not start at the previous quit: ${reason}`)
  try {
    rmSync(file, { force: true })
  } catch {
    // Logged once is enough; a stale file only repeats the line.
  }
}
