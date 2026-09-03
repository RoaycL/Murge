import { describe, expect, it, vi } from 'vitest'
import {
  GatedTunMutationAdapter,
  TunCoordinator,
  type TunMutationAdapter
} from '../src/main/tun/coordinator'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'

const desired = {
  schemaVersion: 2,
  device: 'Product TUN',
  stack: 'mixed'
} as const

function fake(overrides: Partial<TunMutationAdapter> = {}): TunMutationAdapter {
  return {
    recoveryRequired: vi.fn(async () => false),
    enable: vi.fn(async () => ({ outcome: 'active' as const })),
    restore: vi.fn(async () => ({ outcome: 'restored' as const })),
    ...overrides
  }
}

describe('TunCoordinator non-network orchestration', () => {
  it('serializes enable and emergency restore and emits verified phases', async () => {
    const adapter = fake()
    const coordinator = new TunCoordinator(adapter, true)
    const phases: string[] = []
    coordinator.onStatus(status => phases.push(status.phase))

    await Promise.all([coordinator.enable(desired), coordinator.enable(desired)])
    expect(coordinator.getStatus().phase).toBe('active')
    expect(adapter.enable).toHaveBeenCalledTimes(1)

    await coordinator.emergencyDisable()
    expect(coordinator.getStatus().phase).toBe('configured')
    expect(phases).toEqual(['starting', 'active', 'restoring', 'configured'])
  })

  it('recovers an interrupted transaction during renderer-independent initialization', async () => {
    const adapter = fake({ recoveryRequired: vi.fn(async () => true) })
    const coordinator = new TunCoordinator(adapter, true)
    await coordinator.initialize()
    expect(adapter.restore).toHaveBeenCalledTimes(1)
    expect(coordinator.getStatus().phase).toBe('configured')
  })

  it('surfaces a service ownership conflict during initialization without mutating it', async () => {
    const adapter = fake({
      recoveryRequired: vi.fn(async () => {
        throw new ProtocolError(ProtocolErrorCode.TUN_SERVICE_CONFLICT, 'PID identity mismatch')
      })
    })
    const coordinator = new TunCoordinator(adapter, true)
    await coordinator.initialize()
    expect(coordinator.getStatus()).toMatchObject({ phase: 'conflict', conflictDetail: 'PID identity mismatch' })
    expect(adapter.restore).not.toHaveBeenCalled()
  })

  it('surfaces rollback failure and allows a later emergency retry', async () => {
    const restore = vi
      .fn<TunMutationAdapter['restore']>()
      .mockResolvedValueOnce({ outcome: 'restore-failed', errorMessage: 'RESTORE_DENIED' })
      .mockResolvedValueOnce({ outcome: 'restored' })
    const adapter = fake({
      enable: vi.fn(async () => ({ outcome: 'rollback-required', errorMessage: 'APPLY_FAILED' })),
      restore
    })
    const coordinator = new TunCoordinator(adapter, true)

    await coordinator.enable(desired)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'restore-failed', errorMessage: 'RESTORE_DENIED' })
    await coordinator.emergencyDisable()
    expect(coordinator.getStatus().phase).toBe('configured')
  })

  it('preserves external-conflict evidence and offers the disable recovery path', async () => {
    const adapter = fake({
      enable: vi.fn(async () => ({ outcome: 'conflict', conflictDetail: 'route externally modified' }))
    })
    const coordinator = new TunCoordinator(adapter, true)
    await coordinator.enable(desired)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'conflict', conflictDetail: 'route externally modified' })
    expect(adapter.restore).not.toHaveBeenCalled()
    // `conflict` is no longer terminal: a disable re-runs the restore path
    // (which reconciles first) — the only user-facing way out of a conflict.
    await coordinator.emergencyDisable()
    expect(coordinator.getStatus().phase).toBe('configured')
    expect(adapter.restore).toHaveBeenCalledTimes(1)
  })

  it('allows a later enable to retry from restore-failed', async () => {
    const adapter = fake({
      enable: vi
        .fn<TunMutationAdapter['enable']>()
        .mockResolvedValueOnce({ outcome: 'rollback-required', errorMessage: 'APPLY_FAILED' })
        .mockResolvedValueOnce({ outcome: 'active' }),
      restore: vi.fn(async () => ({ outcome: 'restore-failed', errorMessage: 'RESTORE_DENIED' }))
    })
    const coordinator = new TunCoordinator(adapter, true)
    await coordinator.enable(desired)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'restore-failed', errorMessage: 'RESTORE_DENIED' })
    // The mode switch already stopped the main kernel in this state, so a
    // retried enable is the natural recovery (mode-transition.ts relies on it).
    await coordinator.enable(desired)
    expect(coordinator.getStatus().phase).toBe('active')
    expect(adapter.enable).toHaveBeenCalledTimes(2)
  })

  it('does not let a failing subscriber interrupt recovery', async () => {
    const adapter = fake()
    const coordinator = new TunCoordinator(adapter, true)
    coordinator.onStatus(() => { throw new Error('renderer gone') })
    await coordinator.enable(desired)
    await coordinator.emergencyDisable()
    expect(coordinator.getStatus().phase).toBe('configured')
  })

  it('fails closed behind the production gate and never becomes active', async () => {
    const coordinator = new TunCoordinator(new GatedTunMutationAdapter(), true)
    await coordinator.enable(desired)
    expect(coordinator.getStatus()).toMatchObject({
      phase: 'failed',
      errorMessage: ProtocolErrorCode.TUN_IMPLEMENTATION_GATED
    })
  })

  it('rejects malformed desired state before invoking the adapter', async () => {
    const adapter = fake()
    const coordinator = new TunCoordinator(adapter, true)
    await expect(coordinator.enable({ ...desired, schemaVersion: 1 })).rejects.toThrow()
    expect(adapter.enable).not.toHaveBeenCalled()
    expect(coordinator.getStatus().phase).toBe('configured')
  })

  it('keeps unsupported platforms inert', async () => {
    const adapter = fake()
    const coordinator = new TunCoordinator(adapter, false)
    await coordinator.initialize()
    await coordinator.emergencyDisable()
    expect(coordinator.getStatus().phase).toBe('unsupported')
    expect(adapter.recoveryRequired).not.toHaveBeenCalled()
    expect(adapter.restore).not.toHaveBeenCalled()
  })
})

/**
 * The coordinator reports the owned session's inbound so the system proxy can
 * point at the elevated TUN child while the main kernel is stopped. It must only
 * do so while TUN is genuinely serving traffic.
 */
describe('TunCoordinator owned-session port', () => {
  const withRuntime = (mixedPort: number, overrides: Partial<TunMutationAdapter> = {}) =>
    fake({ getActiveRuntime: () => ({ mixedPort }), ...overrides })

  it('reports the port only while active', async () => {
    const coordinator = new TunCoordinator(withRuntime(17890), true)
    expect(coordinator.getActiveMixedPort()).toBeNull()
    await coordinator.enable(desired)
    expect(coordinator.getActiveMixedPort()).toBe(17890)
    await coordinator.emergencyDisable()
    expect(coordinator.getActiveMixedPort()).toBeNull()
  })

  it('reports null when the adapter owns no process', async () => {
    // The gated placeholder exposes no runtime; a missing accessor must not throw.
    const coordinator = new TunCoordinator(fake(), true)
    await coordinator.enable(desired)
    expect(coordinator.getActiveMixedPort()).toBeNull()
  })

  it('does not report a port for a session that failed to become ready', async () => {
    const coordinator = new TunCoordinator(
      withRuntime(17890, {
        enable: vi.fn(async () => ({ outcome: 'rollback-required' as const, errorMessage: 'timeout' }))
      }),
      true
    )
    await coordinator.enable(desired)
    expect(coordinator.getStatus().phase).not.toBe('active')
    expect(coordinator.getActiveMixedPort()).toBeNull()
  })
})
