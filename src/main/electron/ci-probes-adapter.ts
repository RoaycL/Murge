import { app } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KernelGateway } from '@shared/gateways'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { SystemProxyService } from '../system-proxy/service'
import { WindowsSystemProxyAdapter } from '../system-proxy/adapters/windows-adapter'
import { DisabledSystemProxyAdapter } from '../system-proxy/adapters/disabled-adapter'
import { FileSystemProxyBackupStore } from '../system-proxy/backup-store'
import { StaticSystemProxyProbe, LiveSystemProxyKernelProbe, type LiveProbeMihomo } from '../system-proxy/probe'

/**
 * CI / NSIS headless probe adapter.
 *
 * These probes run the packaged production build without a GUI; they touch
 * Electron process lifecycle (`app.exit`) so they live behind this adapter.
 * Bodies are extracted verbatim from the former monolithic
 * `src/main/index.ts` — probe output formats are asserted by CI workflows and
 * must not drift.
 */

/**
 * CI-only packaging probe. Runs a packaged production build with
 * `--packaging-smoke` and proves the storage wiring is functional without
 * touching the host's network stack: no window, no kernel, no socket is
 * created. It writes a sentinel into the stable profile root (so the Windows
 * smoke workflow can assert the profile survives an uninstall) and exits 0.
 */
export async function runPackagingSmoke(profileRoot: string): Promise<void> {
  const sentinelPath = join(profileRoot, '.packaging-smoke-sentinel')
  try {
    await writeFile(
      sentinelPath,
      JSON.stringify({ mode: 'packaging-smoke', pid: process.pid, at: new Date().toISOString() }, null, 2) + '\n',
      'utf8'
    )
    const evidence = {
      mode: 'packaging-smoke',
      profileRoot,
      sentinel: sentinelPath,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch
    }
    // A single-line, stable marker leaves an audit trail in CI logs; it is not a
    // substitute for the portable assertion the smoke workflow performs.
    console.log(`[packaging-smoke] ${JSON.stringify(evidence)}`)
    // On an automated Windows runner `app.exit(0)` can fail to tear the process
    // down even though no window/kernel exists, leaving the CI step to time out.
    // Arm a hard-exit watchdog so the probe can never hang the workflow, then
    // exit normally. The watchdog is unref'd so a healthy `app.exit` is unaffected.
    const watchdog = setTimeout(() => process.exit(0), 3000)
    watchdog.unref()
    app.exit(0)
  } catch (error) {
    // A failed sentinel must not hang the process either: report and fail fast
    // so CI surfaces the actual reason instead of timing out silently.
    console.error('[packaging-smoke] failed to write the sentinel:', error)
    app.exit(1)
  }
}

/**
 * CI / NSIS-uninstall shutdown hook. Runs the system-proxy restore in a headless
 * process: no window, no kernel, no socket. It reads the brand-independent
 * owned backup from app-data and restores the exact pre-enable registry values
 * (with the precise type preserved), deleting the backup only on a confirmed
 * restore. A conflict is reported without overwriting; a corrupted backup fails
 * closed without ever entering the restore-write path.
 */
export async function runSystemProxyRestore(): Promise<void> {
  const backupStore = FileSystemProxyBackupStore.forAppDataBase(app.getPath('appData'))
  const service = new SystemProxyService({
    adapter:
      process.platform === 'win32'
        ? new WindowsSystemProxyAdapter()
        : new DisabledSystemProxyAdapter(process.platform),
    probe: new StaticSystemProxyProbe({ host: SYSTEM_PROXY_LOOPBACK_HOST, port: 1 }),
    backup: backupStore,
    instanceId: 'restore-cli'
  })
  try {
    const status = await service.init()
    // `disabled` = restored (or nothing owned); `conflict` = the registry no longer
    // matches the written state, so we intentionally did NOT overwrite.
    let ok = status.phase === 'disabled'
    if (status.phase === 'conflict') {
      // The uninstaller aborts on a non-zero restore exit *only* when the owned
      // proxy could not be put back. `init()` collapses both an external-edit
      // conflict (safe — leave the registry untouched) and a corrupt / unreadable
      // backup into `conflict`, so re-read the backup to tell them apart: a backup
      // that still parses is an external edit (continue the uninstall, exit 0); a
      // backup that no longer reads is corrupt and restore has to fail (exit 1).
      try {
        await backupStore.read()
        // A parseable bundle (or none at all) means the registry was simply edited
        // externally; safe to continue.
        ok = true
      } catch {
        ok = false
      }
    }
    console.log(
      `[restore-system-proxy] ${JSON.stringify({
        phase: status.phase,
        ok,
        errorMessage: status.errorMessage ?? null,
        conflictDetail: status.conflictDetail ?? null
      })}`
    )
    app.exit(ok ? 0 : 1)
  } catch (error) {
    console.error('[restore-system-proxy] FAILED:', error)
    app.exit(1)
  }
}

/**
 * CI-only installed-artifact probe: start the bundled kernel, read the *live*
 * mixed-port, socket-prove it (TCP / HTTP CONNECT / SOCKS5), then enable the
 * per-user HKCU system proxy headlessly (writes the owned app-data backup) and
 * exit. Used by the `package-win` job to prove the install -> enable -> uninstall
 * -> exact-restore path.
 *
 * This is intentionally gated behind a CI marker so a packaged Windows build can
 * never let an arbitrary user manufacture a dead-proxy registry state: the probe
 * refuses to run unless BOTH `MURGE_CI_SYSTEM_PROXY_ENABLE=1` and the GitHub
 * Actions runner (enabled + uninstallable) are set. The kernel is started and
 * stopped here; only the proxy registry state (and the owned backup) are left
 * behind for the uninstaller / external recovery helper to restore.
 */
export async function runSystemProxyEnable(
  kernel: KernelGateway,
  mihomo: LiveProbeMihomo
): Promise<void> {
  if (process.env.MURGE_CI_SYSTEM_PROXY_ENABLE !== '1' || process.env.GITHUB_ACTIONS !== 'true') {
    console.error('[system-proxy-enable] refused: not a gated CI run (GITHUB_ACTIONS/MURGE_CI_SYSTEM_PROXY_ENABLE)')
    app.exit(1)
    return
  }
  const service = new SystemProxyService({
    adapter:
      process.platform === 'win32'
        ? new WindowsSystemProxyAdapter()
        : new DisabledSystemProxyAdapter(process.platform),
    probe: new LiveSystemProxyKernelProbe(kernel, mihomo),
    backup: FileSystemProxyBackupStore.forAppDataBase(app.getPath('appData')),
    instanceId: 'enable-cli'
  })
  try {
    const started = await kernel.start()
    if (started.phase !== 'running') {
      throw new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, 'Kernel did not reach running state to enable the system proxy')
    }
    const status = await service.enable()
    // `enabled` = the proxy is now owned by us; `conflict` = the registry already
    // held a different value (idempotent/owned), so we did not overwrite.
    const ok = status.phase === 'enabled' || status.phase === 'conflict'
    console.log(
      `[system-proxy-enable] ${JSON.stringify({
        phase: status.phase,
        ok,
        address: status.address ?? null,
        port: status.port ?? null,
        errorMessage: status.errorMessage ?? null,
        conflictDetail: status.conflictDetail ?? null
      })}`
    )
    // Stop the kernel before exiting so no mihomo child lingers and the proxy is
    // left pointing at a now-dead loopback port — the orphan only the uninstaller
    // / recovery helper must undo. Restore runs standalone and does not need it.
    await kernel.stop().catch(() => undefined)
    app.exit(ok ? 0 : 1)
  } catch (error) {
    console.error('[system-proxy-enable] FAILED:', error)
    await kernel.stop().catch(() => undefined)
    app.exit(1)
  }
}
