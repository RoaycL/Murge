import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { elevationRequestScript, encodePowerShell, helperScriptFile } from '../src/main/updates/installer-handoff'
import { installerArgs } from '../src/main/updates/signed-manifest-driver'

/**
 * Real-Windows check of the last Electron build's move to Tauri, run by
 * `.github/workflows/update-handoff-e2e.yml` on a fresh runner:
 *
 * 1. the released Electron build is installed (per machine, as users have it);
 * 2. the bridge's own hand-off code (elevation request + wscript helper,
 *    exactly as `create-updater-driver.ts` runs it) is given a Tauri setup
 *    and a stand-in "app" process that exits a few seconds later;
 * 3. the helper must wait for that exit, start the Tauri installer with the
 *    takeover arguments, and the installer must replace the Electron install.
 *
 * Skipped unless MURGE_RUN_HANDOFF_E2E=1 (it installs software machine-wide).
 */
const enabled = process.platform === 'win32' && process.env.MURGE_RUN_HANDOFF_E2E === '1'
const ELECTRON_UNINSTALL_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\3a98ddda-fe2a-5afb-97ed-078f905c6c1d'

function regKeyExists(key: string): boolean {
  return spawnSync('reg', ['query', key], { stdio: 'ignore' }).status === 0
}

function onlyExe(dir: string): string {
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.exe'))
  if (files.length !== 1) throw new Error(`expected one installer in ${dir}, found ${files.join(', ')}`)
  return resolve(dir, files[0]!)
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 1000))
  }
}

describe.runIf(enabled)('Electron → Tauri update hand-off on Windows', () => {
  it('installs the Tauri build over the Electron build after the app exits', async () => {
    const root = resolve(process.env.HANDOFF_E2E_DIR ?? 'handoff-e2e')
    const electronSetup = onlyExe(join(root, 'electron'))
    const tauriSetup = onlyExe(join(root, 'tauri'))
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })

    // 1. The Electron build, installed for all users like a normal install.
    const installed = spawnSync(electronSetup, ['/S', '/allusers'], { stdio: 'inherit', timeout: 5 * 60 * 1000 })
    expect(installed.status).toBe(0)
    await waitFor(() => regKeyExists(ELECTRON_UNINSTALL_KEY), 60_000, 'the Electron install to register')

    // 2. A stand-in for the running app: the helper must wait for it to exit.
    const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' })
    const handoff = {
      installerPath: tauriSetup,
      // "重启并安装" without the relaunch (/R would start the app on the runner).
      installerArgs: installerArgs('tauri', 'electron', false),
      parentPid: app.pid!,
      helperFile: join(work, 'install-helper.js'),
      traceFile: join(work, 'install-trace.txt'),
      failureFile: join(work, 'install-failure.txt')
    }
    expect(handoff.installerArgs).toEqual(['/P'])
    writeFileSync(handoff.helperFile, helperScriptFile(handoff))
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const wscript = join(systemRoot, 'System32', 'wscript.exe')
    const request = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-EncodedCommand', encodePowerShell(elevationRequestScript(handoff, wscript))
    ], { stdio: 'inherit', windowsHide: true, timeout: 60_000 })
    expect(request.status).toBe(0)

    const trace = (): string => (existsSync(handoff.traceFile) ? readFileSync(handoff.traceFile, 'utf8') : '')
    // The installer must not start while the app is still running.
    await waitFor(() => trace().includes('Elevated helper started'), 60_000, 'the elevated helper')
    expect(app.exitCode).toBeNull()
    expect(trace()).not.toContain('Starting installer')

    // 3. App exits → installer runs → Tauri replaces Electron.
    await waitFor(() => trace().includes('Installer exit code') || existsSync(handoff.failureFile), 10 * 60 * 1000, 'the installer to finish')
    console.log(trace())
    expect(existsSync(handoff.failureFile) ? readFileSync(handoff.failureFile, 'utf8') : '').toBe('')
    expect(trace()).toContain('Installer exit code: 0')
    expect(regKeyExists(ELECTRON_UNINSTALL_KEY)).toBe(false)
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const brand = JSON.parse(readFileSync(resolve('brand.config.json'), 'utf8')) as { productName: string; executableName: string }
    const installDir = join(programFiles, brand.productName)
    expect(existsSync(join(installDir, `${brand.executableName}.exe`))).toBe(true)
    expect(existsSync(join(installDir, 'resources', 'app.asar'))).toBe(false)
  }, 20 * 60 * 1000)
})
