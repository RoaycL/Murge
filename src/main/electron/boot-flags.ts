import { writeFileSync } from 'node:fs'

/**
 * Boot-flag parsing for the Electron shell.
 *
 * Extracted verbatim from the former monolithic `src/main/index.ts` so the CI
 * probe surface is testable without Electron. Accept the same flags through
 * `MURGE_CI_BOOT_FLAGS` so a self-hosted runner can forward probes through
 * launch wrappers without weakening normal user launches.
 */
export interface BootFlags {
  /** Extra CI-forwarded flags (space separated), parsed once at startup. */
  readonly ciBootFlags: readonly string[]
  /** True when the flag appears in argv OR the CI boot-flag env forwarder. */
  hasArg(flag: string): boolean
  /** Login-item silent launch: the window must not be shown. */
  readonly launchHidden: boolean
  /** Actions-only suppression of the startup runtime-intent replay. */
  readonly skipKernelAutostart: boolean
}

export function parseBootFlags(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): BootFlags {
  const ciBootFlags = (env.MURGE_CI_BOOT_FLAGS ?? '')
    .split(/\s+/)
    .map((flag) => flag.trim())
    .filter(Boolean)
  const hasArg = (flag: string): boolean => argv.includes(flag) || ciBootFlags.includes(flag)
  const launchHidden = hasArg('--hidden')
  const skipKernelAutostart = env.GITHUB_ACTIONS === 'true' && hasArg('--no-kernel-autostart')
  return { ciBootFlags, hasArg, launchHidden, skipKernelAutostart }
}

/**
 * Diagnostics: dump the exact argv + boot flags the packaged process parsed, so
 * a CI spin shows ground truth about whether the probe flag survived delivery.
 * Only writes when the workflow exports MURGE_CI_BOOT_DIAG=1 and a path.
 * Diagnostics must never break the app.
 */
export function writeBootDiagnostics(
  argv: readonly string[],
  flags: BootFlags,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.MURGE_CI_BOOT_DIAG !== '1' || !env.MURGE_CI_BOOT_DIAG_PATH) return
  try {
    writeFileSync(
      env.MURGE_CI_BOOT_DIAG_PATH,
      JSON.stringify({ argv: [...argv], bootFlags: [...flags.ciBootFlags], cwd }, null, 2),
      'utf8'
    )
  } catch {
    /* diagnostics must never break the app */
  }
}

/**
 * CI-only loading-time watchdog for the interactive Windows smoke workflow. If
 * a packaged `--packaging-smoke` probe stalls in Electron initialization,
 * Electron stalls anywhere in startup (window-ready, migration, profile
 * resolution, sentinel write) the process would otherwise hang for the workflow
 * timeout. Arm a timer at module load so it fires no matter WHY startup stalls,
 * and exit non-zero so the workflow fails fast with a deterministic message
 * instead of timing out silently. A healthy probe reaches runPackagingSmoke and
 * exits 0 long before this fires.
 */
export function armPackagingSmokeWatchdog(hasArg: (flag: string) => boolean): void {
  if (hasArg('--packaging-smoke')) {
    setTimeout(() => {
      console.error('[packaging-smoke] watchdog: app never reached runPackagingSmoke within 60s; forcing exit')
      process.exit(1)
    }, 60000)
  }
}

/**
 * The NSIS uninstaller waits synchronously for this headless command. Bound the
 * whole Electron bootstrap/registry restore path so a damaged install can never
 * leave the uninstaller waiting forever.
 */
export function armRestoreWatchdog(hasArg: (flag: string) => boolean): void {
  if (hasArg('--restore-system-proxy')) {
    setTimeout(() => {
      console.error('[restore-system-proxy] watchdog: restore did not finish within 30s')
      process.exit(1)
    }, 30_000)
  }
}

/**
 * Headless CI runners often have no GPU/display, and Electron can stall in
 * window-ready waiting on GPU init. For the CI probe modes (which never open a
 * GUI and exit fast) hardware acceleration must be disabled so startup
 * resolves; normal user launches keep it. The Electron call itself
 * (`app.disableHardwareAcceleration`) stays in the shell entry — this helper
 * only decides.
 */
export function shouldDisableHardwareAcceleration(hasArg: (flag: string) => boolean): boolean {
  return (
    hasArg('--packaging-smoke') ||
    hasArg('--kernel-smoke') ||
    hasArg('--ui-smoke') ||
    hasArg('--hidden-smoke') ||
    hasArg('--system-proxy-enable') ||
    hasArg('--restore-system-proxy')
  )
}
