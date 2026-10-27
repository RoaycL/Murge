/**
 * Hand a verified installer to Windows when the app quits.
 *
 * A plain child process of the app is not guaranteed to outlive it: when the
 * app runs inside a job object that is torn down with it (a login task, a
 * launcher), every non-elevated descendant goes too, and the installer never
 * starts. A UAC-elevated process is created by the AppInfo service instead,
 * outside the caller's job. So the hand-off is two steps:
 *
 * 1. While the app is still alive, a short-lived hidden PowerShell asks for
 *    elevation (`Start-Process -Verb RunAs`) and starts the elevated helper.
 *    The app waits for this step, so the UAC prompt shows while the app quits
 *    and a refusal is recorded.
 * 2. The elevated helper waits for the app to exit, then runs the installer
 *    (already elevated, so no second prompt) with a normal window.
 *
 * The helper is a JScript file run by `wscript.exe`, a GUI program: an
 * elevated console program (PowerShell) gets a console window of its own that
 * `-WindowStyle Hidden` does not reliably hide (Windows Terminal as the
 * default terminal ignores it), and that window stayed up for the whole
 * install. The elevated process does not inherit this process's environment,
 * so every value is embedded in the helper as a string literal; the helper
 * file is saved as UTF-16 with a BOM so non-ASCII paths survive.
 */

export interface InstallerHandoff {
  /** Verified installer to run. */
  installerPath: string
  installerArgs: readonly string[]
  /** This process; the helper waits for it to exit. */
  parentPid: number
  /** Where the elevated helper script is saved (see `helperScriptFile`). */
  helperFile: string
  /** Progress lines from both steps, for diagnosing a failed update. */
  traceFile: string
  /** Why the installer did not run; read and logged on the next launch. */
  failureFile: string
}

/** How long the elevated helper waits for the app to finish quitting. */
export const PARENT_EXIT_TIMEOUT_SECONDS = 120

/**
 * A PowerShell single-quoted string literal. PowerShell also reads the
 * typographic single quotes as delimiters, so each of them is doubled too.
 */
export function psLiteral(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`
}

/** `-EncodedCommand` payload: base64 of the UTF-16LE script. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** A JScript string literal (JSON, with the ES5 line separators escaped). */
export function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** One argument of a Windows command line (CommandLineToArgvW rules). */
export function windowsArg(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** Script of the elevated helper (step 2), run by `wscript.exe`. */
export function elevatedHelperScript(handoff: InstallerHandoff): string {
  const commandLine = [handoff.installerPath, ...handoff.installerArgs].map(windowsArg).join(' ')
  const pid = Math.trunc(handoff.parentPid)
  const timeout = PARENT_EXIT_TIMEOUT_SECONDS
  return [
    `var trace = ${jsLiteral(handoff.traceFile)};`,
    `var failure = ${jsLiteral(handoff.failureFile)};`,
    `var fso = new ActiveXObject('Scripting.FileSystemObject');`,
    `function log(line) {`,
    `  try { var file = fso.OpenTextFile(trace, 8, true); file.WriteLine(line); file.Close(); } catch (e) {}`,
    `}`,
    `function fail(message) {`,
    `  var stream = new ActiveXObject('ADODB.Stream');`,
    `  stream.Type = 2; stream.Charset = 'utf-8'; stream.Open();`,
    `  stream.WriteText(message); stream.SaveToFile(failure, 2); stream.Close();`,
    `}`,
    `function running() {`,
    `  return GetObject('winmgmts:root\\\\cimv2').ExecQuery('SELECT ProcessId FROM Win32_Process WHERE ProcessId = ${pid}').Count > 0;`,
    `}`,
    `try {`,
    `  log('Elevated helper started');`,
    `  var deadline = new Date().getTime() + ${timeout * 1000};`,
    `  while (running()) {`,
    `    if (new Date().getTime() > deadline) throw new Error('the app did not exit within ${timeout} seconds');`,
    `    WScript.Sleep(250);`,
    `  }`,
    `  log('Starting installer');`,
    `  var code = new ActiveXObject('WScript.Shell').Run(${jsLiteral(commandLine)}, 1, true);`,
    `  log('Installer exit code: ' + code);`,
    `  if (code !== 0) throw new Error('Installer exited with code ' + code);`,
    `} catch (e) {`,
    `  try { fail(e.message || String(e)); } catch (ignored) {}`,
    `}`
  ].join('\r\n')
}

/** Contents of `helperFile`: UTF-16LE with a BOM, which WSH reads as Unicode. */
export function helperScriptFile(handoff: InstallerHandoff): Buffer {
  return Buffer.from(`﻿${elevatedHelperScript(handoff)}`, 'utf16le')
}

/**
 * Script of the elevation request (step 1). Exits 0 once the elevated helper
 * runs, 1 when elevation was refused or failed (the reason is in the failure
 * file). `Start-Process` joins `-ArgumentList` with spaces, so the helper path
 * carries its own quotes.
 */
export function elevationRequestScript(handoff: InstallerHandoff, wscriptPath: string): string {
  const helperArgs = ['//B', '//NoLogo', '//E:jscript', windowsArg(handoff.helperFile)].map(psLiteral).join(',')
  const trace = psLiteral(handoff.traceFile)
  return [
    `try {`,
    `  Set-Content -LiteralPath ${trace} -Value 'Requesting elevation' -ErrorAction SilentlyContinue`,
    `  $null = Start-Process -FilePath ${psLiteral(wscriptPath)} -ArgumentList ${helperArgs} -Verb RunAs -ErrorAction Stop`,
    `  Add-Content -LiteralPath ${trace} -Value 'Elevated helper launched' -ErrorAction SilentlyContinue`,
    `  exit 0`,
    `} catch {`,
    `  Set-Content -LiteralPath ${psLiteral(handoff.failureFile)} -Value ('Elevation failed: ' + $_.Exception.Message) -Encoding UTF8`,
    `  exit 1`,
    `}`
  ].join('\n')
}
