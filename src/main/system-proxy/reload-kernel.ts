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
export async function reloadKernelForActiveProfile(deps: KernelReloadDependencies): Promise<void> {
  const status: KernelStatus = await deps.kernel.getStatus()
  if (status.phase !== 'running' && status.phase !== 'starting') return
  const proxyWasEnabled = (await deps.systemProxy.getStatus()).phase === 'enabled'
  await deps.kernel.stop()
  await deps.kernel.start()
  if (proxyWasEnabled) {
    await deps.systemProxy.enable()
  }
}
