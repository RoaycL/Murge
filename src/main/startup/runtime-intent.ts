import type { AppSettings } from '@shared/app-settings'
import type { KernelGateway, SystemProxyGateway } from '@shared/gateways'
import type { KernelStatus } from '@shared/runtime'
import type { SystemProxyStatus } from '@shared/system-proxy'
import type { TunGateway, TunStatus } from '@shared/tun'

export interface RuntimeIntentRestoreDeps {
  kernel: Pick<KernelGateway, 'getStatus' | 'start'>
  tun: Pick<TunGateway, 'getStatus' | 'enable'>
  systemProxy: Pick<SystemProxyGateway, 'getStatus' | 'enable'>
  restoreSelections?: () => Promise<void>
  /** Injectable delay keeps the retry policy deterministic in unit tests. */
  delay?: (ms: number) => Promise<void>
  /** Override with an empty list for one background reconciliation attempt. */
  retryDelaysMs?: readonly number[]
  /** Cancellation fence checked immediately before every state-changing call. */
  shouldContinue?: () => boolean
  log?: (message: string, error?: unknown) => void
}

export interface RuntimeIntentRestoreResult {
  kernel: KernelStatus
  tun: TunStatus
  systemProxy: SystemProxyStatus
  systemProxyPhase: Awaited<ReturnType<SystemProxyGateway['getStatus']>>['phase']
}

const RETRY_DELAYS_MS = [750, 1_500] as const
const RETRYABLE_KERNEL_PHASES = new Set(['stopped', 'failed'])
const RETRYABLE_TUN_PHASES = new Set(['configured', 'failed', 'restore-failed'])
const RETRYABLE_PROXY_PHASES = new Set(['disabled', 'restore-failed'])

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reconcile the last user-selected networking state after boot recovery.
 *
 * Startup services have already restored any orphaned proxy backup and TUN
 * mutation journal before this runs. The order is therefore deliberate:
 * establish an authenticated kernel/controller first, switch that one logical
 * host to TUN with bounded retries, then point the system proxy at the unified
 * mixed-port. No operation is launched concurrently, so a slow Windows service
 * cannot race a second mihomo process for the same ports.
 */
export async function restoreRuntimeIntent(
  settings: AppSettings,
  deps: RuntimeIntentRestoreDeps
): Promise<RuntimeIntentRestoreResult> {
  const delay = deps.delay ?? wait
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS
  const needsHost = settings.autoStartKernel || settings.tunDesired || settings.systemProxyDesired

  let kernelStatus = await deps.kernel.getStatus()
  if (settings.kernelEnabled && needsHost && RETRYABLE_KERNEL_PHASES.has(kernelStatus.phase)) {
    kernelStatus = await retryKernelStart(deps, delay, retryDelays)
  }

  if (kernelStatus.phase === 'running') {
    await restoreSelections(deps)
  }

  let tunStatus = await deps.tun.getStatus()
  if (settings.kernelEnabled && kernelStatus.phase === 'running' && settings.tunDesired) {
    tunStatus = await retryTunStart(deps, delay, retryDelays)
    if (tunStatus.phase === 'active') {
      // A successful mode switch starts a fresh elevated mihomo host. Reapply
      // remembered choices to that controller as well as the ordinary host.
      await restoreSelections(deps)
    }
  }

  kernelStatus = await deps.kernel.getStatus()
  let proxyStatus = await deps.systemProxy.getStatus()
  if (
    settings.kernelEnabled &&
    settings.systemProxyDesired &&
    kernelStatus.phase === 'running' &&
    proxyStatus.supported &&
    RETRYABLE_PROXY_PHASES.has(proxyStatus.phase)
  ) {
    proxyStatus = await retrySystemProxyStart(deps, delay, retryDelays)
  }

  return {
    kernel: kernelStatus,
    tun: tunStatus,
    systemProxy: proxyStatus,
    systemProxyPhase: proxyStatus.phase
  }
}

async function retryKernelStart(
  deps: RuntimeIntentRestoreDeps,
  delay: (ms: number) => Promise<void>,
  retryDelays: readonly number[]
): Promise<KernelStatus> {
  let status = await deps.kernel.getStatus()
  const maxAttempts = retryDelays.length + 1
  for (let attempt = 1; attempt <= maxAttempts && RETRYABLE_KERNEL_PHASES.has(status.phase); attempt++) {
    if (!canContinue(deps)) break
    if (attempt > 1) {
      await delay(retryDelays[attempt - 2]!)
      if (!canContinue(deps)) break
    }
    try {
      status = await deps.kernel.start()
    } catch (error) {
      deps.log?.(`[startup-restore] kernel start failed (${attempt}/${maxAttempts})`, error)
      status = await deps.kernel.getStatus()
    }
  }
  return status
}

async function retryTunStart(
  deps: RuntimeIntentRestoreDeps,
  delay: (ms: number) => Promise<void>,
  retryDelays: readonly number[]
): Promise<TunStatus> {
  let status = await deps.tun.getStatus()
  if (!status.supported || status.phase === 'active') return status

  const maxAttempts = retryDelays.length + 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!RETRYABLE_TUN_PHASES.has(status.phase)) break
    if (!canContinue(deps)) break
    if (attempt > 1) {
      await delay(retryDelays[attempt - 2]!)
      if (!canContinue(deps)) break
    }
    try {
      status = await deps.tun.enable()
    } catch (error) {
      deps.log?.(`[startup-restore] TUN start failed (${attempt}/${maxAttempts})`, error)
      status = await deps.tun.getStatus()
    }
    if (status.phase === 'active') break
  }
  return status
}

async function retrySystemProxyStart(
  deps: RuntimeIntentRestoreDeps,
  delay: (ms: number) => Promise<void>,
  retryDelays: readonly number[]
): Promise<Awaited<ReturnType<SystemProxyGateway['getStatus']>>> {
  let status = await deps.systemProxy.getStatus()
  const maxAttempts = retryDelays.length + 1
  for (let attempt = 1; attempt <= maxAttempts && RETRYABLE_PROXY_PHASES.has(status.phase); attempt++) {
    if (!status.supported) break
    if (!canContinue(deps)) break
    if (attempt > 1) {
      await delay(retryDelays[attempt - 2]!)
      if (!canContinue(deps)) break
    }
    try {
      status = await deps.systemProxy.enable()
    } catch (error) {
      deps.log?.(`[startup-restore] system proxy start failed (${attempt}/${maxAttempts})`, error)
      status = await deps.systemProxy.getStatus()
    }
  }
  return status
}

function canContinue(deps: RuntimeIntentRestoreDeps): boolean {
  return deps.shouldContinue?.() ?? true
}

async function restoreSelections(deps: RuntimeIntentRestoreDeps): Promise<void> {
  try {
    await deps.restoreSelections?.()
  } catch (error) {
    // A remembered node becoming unavailable must not tear down a healthy host.
    deps.log?.('[startup-restore] proxy selection restore failed', error)
  }
}
