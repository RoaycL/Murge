import { describe, expect, it, vi } from 'vitest'
import {
  createPrivilegedExitMonitorTick,
  type PrivilegedExitMonitorDeps
} from '../src/main/kernel/privileged-exit-monitor'
import { TunCoordinator, type TunMutationAdapter } from '../src/main/tun/coordinator'
import type { KernelStatus } from '../src/shared/runtime'

const desired = { schemaVersion: 2, device: 'Product TUN', stack: 'mixed' } as const

function kernelStatus(phase: KernelStatus['phase']): KernelStatus {
  return { phase, pid: null, version: null, controllerUrl: null, startedAt: null, lastError: null }
}

function harness(options: {
  coordinator: TunCoordinator
  settings?: { autoStartKernel: boolean; tunDesired: boolean; systemProxyDesired: boolean }
}) {
  let phase: KernelStatus['phase'] = 'running'
  const deps = {
    kernel: {
      getStatus: () => kernelStatus(phase),
      reconcileLiveness: vi.fn(async () => {
        phase = 'failed'
        return false
      })
    },
    handleHostExit: vi.fn(() => options.coordinator.handleHostExit()),
    restoreSystemProxy: vi.fn(async () => undefined),
    readSettings: vi.fn(async () => options.settings ?? { autoStartKernel: true, tunDesired: true, systemProxyDesired: true }),
    startKernel: vi.fn(async () => undefined),
    wakeIntentRecovery: vi.fn(),
    onError: vi.fn()
  } satisfies PrivilegedExitMonitorDeps
  return { deps, tick: createPrivilegedExitMonitorTick(deps), setKernelPhase: (next: KernelStatus['phase']) => { phase = next } }
}

function adapter(overrides: Partial<TunMutationAdapter> = {}): TunMutationAdapter {
  return {
    recoveryRequired: vi.fn(async () => false),
    enable: vi.fn(async () => ({ outcome: 'active' as const })),
    restore: vi.fn(async () => ({ outcome: 'restored' as const })),
    ...overrides
  }
}

describe('privileged core abnormal-exit monitor', () => {
  it('recovers networking when the core dies after a failed TUN restore', async () => {
    const coordinator = new TunCoordinator(adapter({
      restore: vi.fn(async () => ({ outcome: 'restore-failed' as const, errorMessage: 'RESTORE_DENIED' }))
    }), true)
    await coordinator.enable(desired)
    await coordinator.emergencyDisable()
    expect(coordinator.getStatus().phase).toBe('restore-failed')

    const h = harness({ coordinator })
    await h.tick()

    expect(coordinator.getStatus().phase).toBe('configured')
    expect(h.deps.restoreSystemProxy).toHaveBeenCalledTimes(1)
    expect(h.deps.wakeIntentRecovery).toHaveBeenCalledTimes(1)
  })

  it('recovers networking when the core dies while a TUN restore is in flight', async () => {
    let finishRestore!: () => void
    const coordinator = new TunCoordinator(adapter({
      // The controller died mid-restore: the in-flight call fails late.
      restore: vi.fn(() => new Promise<{ outcome: 'restore-failed'; errorMessage: string }>((resolve) => {
        finishRestore = () => resolve({ outcome: 'restore-failed', errorMessage: 'ECONNREFUSED' })
      }))
    }), true)
    await coordinator.enable(desired)
    const disabling = coordinator.emergencyDisable()
    await Promise.resolve()
    expect(coordinator.getStatus().phase).toBe('restoring')

    const h = harness({ coordinator })
    const ticking = h.tick()
    finishRestore()
    await Promise.all([disabling, ticking])

    expect(coordinator.getStatus().phase).toBe('configured')
    expect(h.deps.restoreSystemProxy).toHaveBeenCalledTimes(1)
    expect(h.deps.wakeIntentRecovery).toHaveBeenCalledTimes(1)
  })

  it('still restores the proxy and replays intent when the TUN reset throws', async () => {
    const coordinator = new TunCoordinator(adapter(), true)
    const h = harness({ coordinator })
    h.deps.handleHostExit.mockRejectedValueOnce(new Error('boom'))
    await h.tick()
    expect(h.deps.restoreSystemProxy).toHaveBeenCalledTimes(1)
    expect(h.deps.wakeIntentRecovery).toHaveBeenCalledTimes(1)
    expect(h.deps.onError).toHaveBeenCalledWith(expect.any(Error), 'tun-reset')
  })

  it('restarts the plain kernel directly when only auto-start is desired', async () => {
    const coordinator = new TunCoordinator(adapter(), true)
    const h = harness({ coordinator, settings: { autoStartKernel: true, tunDesired: false, systemProxyDesired: false } })
    await h.tick()
    expect(h.deps.startKernel).toHaveBeenCalledTimes(1)
    expect(h.deps.wakeIntentRecovery).not.toHaveBeenCalled()
  })

  it('does not probe while the kernel is not serving, and never recovers a live core', async () => {
    const coordinator = new TunCoordinator(adapter(), true)
    const h = harness({ coordinator })
    h.setKernelPhase('stopped')
    await h.tick()
    expect(h.deps.kernel.reconcileLiveness).not.toHaveBeenCalled()

    h.setKernelPhase('running')
    h.deps.kernel.reconcileLiveness.mockResolvedValueOnce(true)
    await h.tick()
    expect(h.deps.handleHostExit).not.toHaveBeenCalled()
  })
})
