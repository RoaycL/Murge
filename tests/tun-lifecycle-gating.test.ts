import { describe, it, expect } from 'vitest'
import type { TunStatus } from '../src/shared/tun'
import { tunLifecycleDetail, tunLifecycleGating } from '../src/renderer/src/lib/tun-lifecycle'

function status(partial: Partial<TunStatus>): TunStatus {
  return { supported: true, phase: 'configured', errorMessage: null, conflictDetail: null, updatedAt: null, ...partial }
}

describe('TUN lifecycle gating', () => {
  it('offers enable only from a settled, supported lifecycle', () => {
    expect(tunLifecycleGating(status({ phase: 'configured' }), false).canEnable).toBe(true)
    expect(tunLifecycleGating(status({ phase: 'failed' }), false).canEnable).toBe(true)
    // `restore-failed` is a retry phase: the mode switch that led there already
    // stopped the main kernel, so re-enabling TUN is the natural recovery.
    expect(tunLifecycleGating(status({ phase: 'restore-failed' }), false).canEnable).toBe(true)
    expect(tunLifecycleGating(status({ phase: 'active' }), false).canEnable).toBe(false)
    expect(tunLifecycleGating(status({ phase: 'starting' }), false).canEnable).toBe(false)
    expect(tunLifecycleGating(status({ phase: 'restoring' }), false).canEnable).toBe(false)
    expect(tunLifecycleGating(status({ phase: 'conflict' }), false).canEnable).toBe(false)
    expect(tunLifecycleGating(status({ phase: 'unsupported' }), false).canEnable).toBe(false)
  })

  it('withholds enable on an unsupported platform and while busy', () => {
    expect(tunLifecycleGating(status({ phase: 'configured', supported: false }), false).canEnable).toBe(false)
    expect(tunLifecycleGating(status({ phase: 'configured' }), true).canEnable).toBe(false)
  })

  it('offers disable/restore only while TUN owns networking or is mid-rollback', () => {
    expect(tunLifecycleGating(status({ phase: 'active' }), false).canDisable).toBe(true)
    expect(tunLifecycleGating(status({ phase: 'starting' }), false).canDisable).toBe(true)
    expect(tunLifecycleGating(status({ phase: 'restoring' }), false).canDisable).toBe(true)
    expect(tunLifecycleGating(status({ phase: 'restore-failed' }), false).canDisable).toBe(true)
    // `conflict` is no longer a dead end: the disable path reconciles with the
    // service first, which is the only way a latched conflict clears.
    expect(tunLifecycleGating(status({ phase: 'conflict' }), false).canDisable).toBe(true)
    expect(tunLifecycleGating(status({ phase: 'configured' }), false).canDisable).toBe(false)
    expect(tunLifecycleGating(status({ phase: 'failed' }), false).canDisable).toBe(false)
    expect(tunLifecycleGating(status({ phase: 'unsupported' }), false).canDisable).toBe(false)
  })

  it('marks a failed phase as a retry and reports conflict/error detail', () => {
    expect(tunLifecycleGating(status({ phase: 'failed', errorMessage: 'x' }), false).enableLabel).toBe('重试启用')
    expect(tunLifecycleGating(status({ phase: 'configured' }), false).enableLabel).toBe('启用')

    const conflict = tunLifecycleGating(status({ phase: 'conflict', conflictDetail: 'route modified' }), false)
    expect(conflict.showConflict).toBe(true)
    expect(conflict.showError).toBe(false)

    const failed = tunLifecycleGating(status({ phase: 'failed', errorMessage: 'enable failed' }), false)
    expect(failed.showError).toBe(true)
    expect(failed.showConflict).toBe(false)
  })

  it('surfaces the richest user-facing detail', () => {
    expect(tunLifecycleDetail(status({ conflictDetail: 'route modified', errorMessage: 'x' }))).toBe('route modified')
    expect(tunLifecycleDetail(status({ errorMessage: 'enable failed' }))).toBe('enable failed')
    expect(tunLifecycleDetail(status({ conflictDetail: null, errorMessage: null }))).toBeNull()
  })
})
