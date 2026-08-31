import type { KernelGateway } from '../../shared/gateways'
import type { KernelStatus } from '../../shared/runtime'
import type { SystemProxyStatus } from '../../shared/system-proxy'

/** Narrow structural deps so the coordinator is trivially fakeable in tests. */
export interface KernelReloadDependencies {
  /** Ordered kernel gateway: `stop()` restores the system proxy first. */
  kernel: Pick<KernelGateway, 'getStatus' | 'start' | 'stop'>
  systemProxy: {
    getStatus(): SystemProxyStatus | Promise<SystemProxyStatus>
    enable(): Promise<SystemProxyStatus>
  }
}

export interface KernelReloadOptions {
  /** Restore the previous active pointer when replacement cannot be applied. */
  rollbackActive?: () => Promise<void>
}

/**
 * Restart a running kernel so it re-materializes from the now-active profile
 * document (the stored profile's proxies/groups/rules), preserving the system
 * proxy across the restart.
 *
 * No-op when the kernel is not running/starting: the active profile is picked up
 * on the next manual start, so we neither spin up a kernel the user did not ask
 * for nor disturb a stopped state.
 *
 * Restart is stop-then-start through the ordered gateway, so any owned system
 * proxy is restored before the controller becomes unavailable. Because the
 * kernel's mixed-port/controller-port/secret are pinned for the session, the
 * controller URL is stable, and re-enabling the proxy after start simply
 * re-points it at the same (now reloaded) listener. The proxy is only re-enabled
 * when it was owned before the restart, so a user who never enabled it is
 * unaffected.
 */
export async function reloadKernelForActiveProfile(
  deps: KernelReloadDependencies,
  options: KernelReloadOptions = {}
): Promise<void> {
  const status: KernelStatus = await deps.kernel.getStatus()
  if (status.phase !== 'running' && status.phase !== 'starting') return
  const proxyWasEnabled = (await deps.systemProxy.getStatus()).phase === 'enabled'
  try {
    await deps.kernel.stop()
  } catch (error) {
    try {
      await options.rollbackActive?.()
    } catch {
      // Preserve the lifecycle failure; no replacement process was started.
    }
    throw error
  }
  try {
    await deps.kernel.start()
  } catch (replacementError) {
    if (options.rollbackActive) {
      let rollbackSucceeded = false
      try {
        await options.rollbackActive()
        rollbackSucceeded = true
      } catch {
        // Never restart against a pointer/document whose restoration failed.
      }
      // Best-effort recovery is deliberately attempted before propagating the
      // original failure. If recovery also fails, the original apply error is
      // still the most useful renderer-facing cause.
      if (rollbackSucceeded) {
        try {
          await deps.kernel.start()
          if (proxyWasEnabled) await deps.systemProxy.enable()
        } catch {
          // Kernel status/logs retain the recovery failure for diagnostics.
        }
      }
    }
    throw replacementError
  }
  if (proxyWasEnabled) {
    await deps.systemProxy.enable()
  }
}
