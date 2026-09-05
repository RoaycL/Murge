import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../src/shared/app-settings'
import type { KernelStatus } from '../src/shared/runtime'
import type { SystemProxyStatus } from '../src/shared/system-proxy'
import type { TunStatus } from '../src/shared/tun'
import {
  RuntimeIntentRecoveryCoordinator,
  type ObservableAppSettings
} from '../src/main/startup/runtime-intent-recovery'

const kernelRunning = (): KernelStatus => ({
  phase: 'running',
  pid: 42,
  version: null,
  controllerUrl: 'http://127.0.0.1:9090',
  startedAt: null,
  lastError: null
})

const tunStatus = (phase: TunStatus['phase']): TunStatus => ({
  supported: true,
  phase,
  errorMessage: null,
  conflictDetail: null,
  updatedAt: null
})

const proxyDisabled = (): SystemProxyStatus => ({
  supported: true,
  phase: 'disabled',
  address: null,
  port: null,
  proxyOverride: null,
  errorMessage: null,
  conflictDetail: null,
  updatedAt: null
})

class SettingsHarness implements ObservableAppSettings {
  private readonly listeners = new Set<(settings: AppSettings) => void>()

  constructor(public value: AppSettings) {}

  async get(): Promise<AppSettings> {
    return { ...this.value }
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(patch: Partial<AppSettings>): void {
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener({ ...this.value })
  }
}

function makeCoordinator(settings: SettingsHarness, enableTun: () => Promise<TunStatus>) {
  let tun = tunStatus('configured')
  const wrappedEnable = vi.fn(async () => {
    tun = await enableTun()
    return tun
  })
  const coordinator = new RuntimeIntentRecoveryCoordinator({
    settings,
    restore: {
      kernel: { getStatus: async () => kernelRunning(), start: vi.fn() },
      tun: { getStatus: async () => tun, enable: wrappedEnable },
      systemProxy: { getStatus: async () => proxyDisabled(), enable: vi.fn() }
    }
  })
  return { coordinator, enableTun: wrappedEnable }
}

describe('RuntimeIntentRecoveryCoordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retries in the background and stops after the desired state is reached', async () => {
    const settings = new SettingsHarness({ ...DEFAULT_APP_SETTINGS, tunDesired: true })
    let attempt = 0
    const { coordinator, enableTun } = makeCoordinator(settings, async () => {
      attempt += 1
      return tunStatus(attempt === 2 ? 'active' : 'configured')
    })

    coordinator.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(enableTun).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(enableTun).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(enableTun).toHaveBeenCalledTimes(2)
    coordinator.stop()
  })

  it('wakes immediately on network recovery without creating concurrent retries', async () => {
    const settings = new SettingsHarness({ ...DEFAULT_APP_SETTINGS, tunDesired: true })
    const { coordinator, enableTun } = makeCoordinator(settings, async () => tunStatus('active'))

    coordinator.start()
    coordinator.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(enableTun).toHaveBeenCalledOnce()
    coordinator.stop()
  })

  it('cancels a pending ON when the user persists OFF', async () => {
    const settings = new SettingsHarness({ ...DEFAULT_APP_SETTINGS, tunDesired: true })
    const { coordinator, enableTun } = makeCoordinator(settings, async () => tunStatus('active'))

    coordinator.start()
    settings.emit({ tunDesired: false })
    await vi.advanceTimersByTimeAsync(180_000)
    expect(enableTun).not.toHaveBeenCalled()
    coordinator.stop()
  })

  it('stops after the bounded two-minute retry window', async () => {
    const settings = new SettingsHarness({ ...DEFAULT_APP_SETTINGS, tunDesired: true })
    const { coordinator, enableTun } = makeCoordinator(settings, async () => tunStatus('configured'))

    coordinator.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(enableTun).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(enableTun).toHaveBeenCalledTimes(6)
    coordinator.stop()
  })
})
