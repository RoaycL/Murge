import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as pause } from 'node:timers/promises'

if (process.platform !== 'win32') throw new Error('This smoke test requires Windows; refusing to silently skip')
const root = process.cwd()
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const require = createRequire(resolve(root, 'package.json'))
const WebSocket = require('ws')
const brand = JSON.parse(await readFile(resolve(root, 'brand.config.json'), 'utf8'))
const output = resolve(process.env.RUNNER_TEMP || tmpdir(), 'tauri-gui-evidence')
const isolated = await mkdtemp(resolve(process.env.RUNNER_TEMP || tmpdir(), 'tauri-smoke-'))
await mkdir(output, { recursive: true })
await mkdir(resolve(isolated, brand.appId), { recursive: true })
await writeFile(resolve(isolated, brand.appId, 'app-settings.json'), JSON.stringify({
  autoStartKernel: false, autoCheckUpdate: false, systemProxyDesired: false,
  tunDesired: false, closeToTray: false, subStoreEnabled: false
}))

const nativeScript = resolve(isolated, 'window.ps1')
await writeFile(nativeScript, String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TauriWindowProbe {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left, Top, Right, Bottom;}
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$p=Get-Process -Id ([int]$env:CI_TAURI_PID) -ErrorAction Stop
$p.Refresh();$h=$p.MainWindowHandle
if($h -eq 0 -or -not [TauriWindowProbe]::IsWindowVisible($h)){throw 'Native window is not visible'}
if($env:CI_TAURI_ACTION -eq 'close') {
 if(-not $p.CloseMainWindow()){throw 'Native close request failed'}
 Write-Output '{"closeRequested":true}'
} elseif($env:CI_TAURI_ACTION -eq 'capture') {
 $null=[TauriWindowProbe]::SetForegroundWindow($h)
 Start-Sleep -Milliseconds 500
 $r=New-Object TauriWindowProbe+Rect
 if(-not [TauriWindowProbe]::GetWindowRect($h,[ref]$r)){throw 'Cannot read native window bounds'}
 $width=$r.Right-$r.Left;$height=$r.Bottom-$r.Top
 if($width -lt 100 -or $height -lt 100){throw 'Invalid native window dimensions'}
 $bitmap=New-Object System.Drawing.Bitmap($width,$height)
 $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
 try {$graphics.CopyFromScreen($r.Left,$r.Top,0,0,$bitmap.Size);$bitmap.Save($env:CI_TAURI_SCREENSHOT,[System.Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}
 Write-Output '{"captured":true}'
}else{Write-Output ('{"pid":'+$p.Id+',"visible":true}')}
`)

async function native(pid, action = 'inspect', screenshot = '') {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeScript], {
    windowsHide: true, env: { ...process.env, CI_TAURI_PID: String(pid), CI_TAURI_ACTION: action, CI_TAURI_SCREENSHOT: screenshot }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-16384) })
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16384) })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [code] = await once(child, 'exit')
    if (code !== 0) throw new Error(`Native ${action} failed: ${stderr}`)
    return JSON.parse(stdout.trim())
  } finally { clearTimeout(timer) }
}

async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const value = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return value
}

async function waitFor(operation, alive, timeout = 45_000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    if (!alive()) throw new Error('Application exited or crashed during smoke test')
    try { const result = await operation(); if (result) return result } catch (error) { last = error }
    await pause(250)
  }
  throw new Error(`Smoke condition timed out${last ? `: ${last.message}` : ''}`)
}

async function connect(url) {
  const socket = new WebSocket(url, { handshakeTimeout: 10_000 })
  await once(socket, 'open')
  let sequence = 0
  const pending = new Map()
  const failures = []
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.method === 'Runtime.exceptionThrown' || message.method === 'Inspector.targetCrashed') failures.push(message.method)
    const task = pending.get(message.id)
    if (!task) return
    pending.delete(message.id)
    clearTimeout(task.timer)
    if (message.error) task.reject(new Error(message.error.message))
    else task.resolve(message.result)
  })
  const disconnected = () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP disconnected')) }
    pending.clear()
  }
  socket.on('close', disconnected)
  socket.on('error', disconnected)
  return {
    failures,
    close: () => socket.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, 15_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) { clearTimeout(timer); pending.delete(id); reject(error) }
      })
    })
  }
}

async function smoke(kind, executable, args = []) {
  const debugPort = await port()
  const env = { ...process.env, APPDATA: isolated, WEBVIEW2_USER_DATA_FOLDER: resolve(isolated, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1` }
  const child = spawn(executable, kind === 'electron' ? [...args, `--remote-debugging-port=${debugPort}`, '--no-kernel-autostart'] : args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let exit, cdp, log = ''
  child.once('exit', (code, signal) => { exit = { code, signal } })
  child.on('error', (error) => { exit = { error: error.message } })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { log = (log + chunk).slice(-65536) })
  const alive = () => !exit
  try {
    const window = await waitFor(() => native(child.pid), alive)
    assert.equal(window.visible, true)
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000) })
      const targets = await response.json()
      return targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools:'))
    }, alive)
    cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error('Renderer evaluation failed')
      return result.result?.value
    }
    await waitFor(() => evaluate(`Boolean(document.querySelector('#app .app-frame') && document.querySelector('.sidebar-nav') && window.desktop?.app?.getBrand)`), alive)
    const identity = await evaluate(`window.desktop.app.getBrand().then(({appId}) => appId)`)
    assert.equal(identity, brand.appId, 'Real renderer-to-backend IPC must work')
    await evaluate(`window.desktop.appSettings.set({closeToTray:false})`)
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`)
      await pause(500)
      await native(child.pid, 'capture', resolve(output, `${kind}-${theme}.png`))
    }
    await pause(3000)
    assert.ok(alive(), 'Application must remain alive after rendering')
    assert.deepEqual(cdp.failures, [], 'Renderer must not emit uncaught exceptions or crashes')
    await native(child.pid, 'close')
    await waitFor(async () => exit, () => true, 30_000)
    assert.equal(exit.code, 0, 'Native close must exit normally; forced termination never counts as success')
    assert.equal(exit.signal, null)
    return { kind, windowVisible: true, rendererLoaded: true, backendIpc: true, stable: true, normalExit: true }
  } finally {
    cdp?.close()
    // Failure cleanup is scoped to the recorded child PID and never reports a
    // forced kill as a passing normal-exit check.
    if (alive()) {
      try {
        await native(child.pid, 'close')
        await waitFor(async () => exit, () => true, 10_000)
      } catch {
        const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        await once(cleanup, 'exit')
      }
    }
    await writeFile(resolve(output, `${kind}.log`), log)
  }
}

try {
  const executable = resolve(root, 'src-tauri/target/x86_64-pc-windows-msvc/release', `${brand.executableName}.exe`)
  const evidence = [await smoke('tauri', executable)]
  if (process.argv.includes('--compare-electron')) evidence.push(await smoke('electron', require('electron'), [root]))
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ sourceCommit, workflowCommit: process.env.GITHUB_SHA, evidence }, null, 2) + '\n')
  console.log('TAURI_GUI_SMOKE=PASS')
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ sourceCommit, workflowCommit: process.env.GITHUB_SHA, error: error.message }, null, 2) + '\n')
  throw error
}
