/**
 * Hand a verified installer to Windows when the app quits.
 *
 * A plain child process of the app is not guaranteed to outlive it: when the
 * app runs inside a job object that is torn down with it (a login task, a
 * launcher), every non-elevated descendant goes too, and the installer never
 * starts. A UAC-elevated process is created by the AppInfo service instead,
 * outside the caller's job. So the hand-off is two steps:
 *
 * 1. While the app is still alive, a short-lived PowerShell asks for elevation
 *    (`Start-Process -Verb RunAs`) and starts the elevated helper. The app
 *    waits for this step, so the UAC prompt shows while the app quits and a
 *    refusal is recorded.
 * 2. The elevated helper waits for the app to exit, then runs the installer
 *    (already elevated, so no second prompt) with a normal window.
 *
 * The elevated process does not inherit this process's environment, so every
 * value is embedded in its script as a single-quoted PowerShell literal and
 * the script travels as `-EncodedCommand` (no command-line quoting at all).
 */

export interface InstallerHandoff {
  /** Verified installer to run. */
  installerPath: string
  installerArgs: readonly string[]
  /** This process; the helper waits for it to exit. */
  parentPid: number
  /** Progress lines from both steps, for diagnosing a failed update. */
  traceFile: string
  /** Why the installer did not run; read and logged on the next launch. */
  failureFile: string
}

/** How long the elevated helper waits for the app to finish quitting. */
export const PARENT_EXIT_TIMEOUT_SECONDS = 120

/** A PowerShell single-quoted string literal. */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** `-EncodedCommand` payload: base64 of the UTF-16LE script. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Script of the elevated helper (step 2). */
export function elevatedHelperScript(handoff: InstallerHandoff): string {
  const trace = psLiteral(handoff.traceFile)
  const failure = psLiteral(handoff.failureFile)
  const args = handoff.installerArgs.map(psLiteral).join(',')
  const pid = Math.trunc(handoff.parentPid)
  return [
    `try {`,
    `  Add-Content -LiteralPath ${trace} -Value 'Elevated helper started' -ErrorAction SilentlyContinue`,
    `  Wait-Process -Id ${pid} -Timeout ${PARENT_EXIT_TIMEOUT_SECONDS} -ErrorAction SilentlyContinue`,
    `  if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { throw 'the app did not exit within ${PARENT_EXIT_TIMEOUT_SECONDS} seconds' }`,
    `  Add-Content -LiteralPath ${trace} -Value 'Starting installer' -ErrorAction SilentlyContinue`,
    `  $installer = Start-Process -FilePath ${psLiteral(handoff.installerPath)}` +
      (args ? ` -ArgumentList ${args}` : '') +
      ` -WindowStyle Normal -Wait -PassThru -ErrorAction Stop`,
    `  Add-Content -LiteralPath ${trace} -Value ('Installer exit code: ' + $installer.ExitCode) -ErrorAction SilentlyContinue`,
    `  if ($installer.ExitCode -ne 0) { throw ('Installer exited with code ' + $installer.ExitCode) }`,
    `} catch {`,
    `  Set-Content -LiteralPath ${failure} -Value $_.Exception.Message -Encoding UTF8`,
    `}`
  ].join('\n')
}

/**
 * Script of the elevation request (step 1). Exits 0 once the elevated helper
 * runs, 1 when elevation was refused or failed (the reason is in the failure
 * file).
 */
export function elevationRequestScript(handoff: InstallerHandoff, powershellPath: string): string {
  const helperArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-EncodedCommand', encodePowerShell(elevatedHelperScript(handoff))].map(psLiteral).join(',')
  const trace = psLiteral(handoff.traceFile)
  return [
    `try {`,
    `  Set-Content -LiteralPath ${trace} -Value 'Requesting elevation' -ErrorAction SilentlyContinue`,
    `  $null = Start-Process -FilePath ${psLiteral(powershellPath)} -ArgumentList ${helperArgs} -Verb RunAs -WindowStyle Hidden -ErrorAction Stop`,
    `  Add-Content -LiteralPath ${trace} -Value 'Elevated helper launched' -ErrorAction SilentlyContinue`,
    `  exit 0`,
    `} catch {`,
    `  Set-Content -LiteralPath ${psLiteral(handoff.failureFile)} -Value ('Elevation failed: ' + $_.Exception.Message) -Encoding UTF8`,
    `  exit 1`,
    `}`
  ].join('\n')
}
