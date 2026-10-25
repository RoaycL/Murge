import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, net, Notification } from 'electron'
import { brand } from '@shared/brand'
import { ElectronUpdaterDriver } from './electron-updater-driver'
import { elevationRequestScript, encodePowerShell, type InstallerHandoff } from './installer-handoff'
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
    launchInstaller: (file, args) => launchElevatedInstaller({
      installerPath: file,
      installerArgs: args,
      parentPid: process.pid,
      traceFile: join(downloadDir, 'install-trace.txt'),
      failureFile
    }),
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

/** How long the quit waits for the user to answer the UAC prompt. */
const ELEVATION_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Get the elevated installer helper running before this process exits (see
 * installer-handoff.ts): the quit waits here while the UAC prompt is up.
 */
function launchElevatedInstaller(handoff: InstallerHandoff): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = elevationRequestScript(handoff, powershell)
  return new Promise((resolve) => {
    const fail = (reason: string): void => {
      console.error(`[updates] the update installer was not handed off: ${reason}`)
      try {
        writeFileSync(handoff.failureFile, reason, 'utf8')
      } catch {
        // The console line above is the record.
      }
    }
    const child = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShell(script)],
      { stdio: 'ignore', windowsHide: true }
    )
    const timer = setTimeout(() => {
      child.kill()
      fail('no answer to the administrator prompt')
      resolve()
    }, ELEVATION_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      fail(`failed to start PowerShell: ${error.message}`)
      resolve()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) console.info('[updates] elevated installer helper started')
      else console.error(`[updates] the update installer was not handed off (exit code ${code}); see ${handoff.failureFile}`)
      resolve()
    })
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
