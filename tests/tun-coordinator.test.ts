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

  it('preserves external-conflict evidence and does not attempt destructive restore', async () => {
    const adapter = fake({
      enable: vi.fn(async () => ({ outcome: 'conflict', conflictDetail: 'route externally modified' }))
    })
    const coordinator = new TunCoordinator(adapter, true)
    await coordinator.enable(desired)
    expect(coordinator.getStatus()).toMatchObject({ phase: 'conflict', conflictDetail: 'route externally modified' })
    expect(adapter.restore).not.toHaveBeenCalled()
    await coordinator.emergencyDisable()
    expect(coordinator.getStatus().phase).toBe('conflict')
    expect(adapter.restore).not.toHaveBeenCalled()
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
