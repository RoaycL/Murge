import { describe, it, expect } from 'vitest'
import { NetworkDetector, type NetworkDetectorGateway } from '../src/main/services/network-detector'

type GatewayLog = Array<
  | 'handleNetworkUp'
  | 'handleNetworkDown'
  | 'startKernel'
  | 'stopKernel'
>

interface Harness {
  detector: NetworkDetector
  online: { value: boolean }
  kernelRunning: { value: boolean }
  calls: GatewayLog
  startKernelRejects: { value: Error | null }
  tick(): Promise<void>
  stop(): void
}

function createHarness(options: { online?: boolean; kernelRunning?: boolean } = {}): Harness {
  const online = { value: options.online ?? true }
  const kernelRunning = { value: options.kernelRunning ?? true }
  const calls: GatewayLog = []
  const startKernelRejects = { value: null as Error | null }
  const gateway: NetworkDetectorGateway = {
    isKernelRunning: () => kernelRunning.value,
    startKernel: () => {
      calls.push('startKernel')
      if (startKernelRejects.value) return Promise.reject(startKernelRejects.value)
      kernelRunning.value = true
      return Promise.resolve(undefined)
    },
    stopKernel: () => {
      calls.push('stopKernel')
      kernelRunning.value = false
      return Promise.resolve(undefined)
    },
    handleNetworkDown: () => {
      calls.push('handleNetworkDown')
      return Promise.resolve(undefined)
    },
    handleNetworkUp: () => {
      calls.push('handleNetworkUp')
      return Promise.resolve(undefined)
    }
  }
  // Run the periodic body directly: the cadence itself is Electron's setInterval.
  const detector = new NetworkDetector({
    gateway,
    intervalSeconds: 15,
    isOnlineFn: () => online.value,
    networkInterfacesFn: () => ({ eth0: iface() }),
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    log: () => undefined
  })
  const anyDetector = detector as unknown as { tick(generation: number): Promise<void>; generation: number }
  return {
    detector,
    online,
    kernelRunning,
    calls,
    startKernelRejects,
    tick: () => anyDetector.tick(anyDetector.generation),
    stop: () => detector.stop()
  }
}

const iface = (): NodeJS.NetworkInterfaceInfo[] => [{ family: 'IPv4', internal: false } as unknown as NodeJS.NetworkInterfaceInfo]

describe('NetworkDetector', () => {
  it('does nothing on a healthy connected machine', async () => {
    const h = createHarness({ online: true, kernelRunning: true })
    await h.tick()
    expect(h.calls).toEqual([])
  })

  it('on going offline: disables the proxy and stops the kernel once', async () => {
    const h = createHarness({ online: true })
    await h.tick()
    h.online.value = false
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel'])

    // Repeated offline ticks do not re-issue stop cycles (no flapping).
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel'])
  })

  it('on recovery after an outage: restarts the kernel, re-enables the proxy', async () => {
    const h = createHarness({ online: true })
    await h.tick()
    h.online.value = false
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel'])

    h.online.value = true
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel', 'startKernel', 'handleNetworkUp'])

    // A second healthy tick is a no-op.
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel', 'startKernel', 'handleNetworkUp'])
  })

  it('a pre-existing kernel crash is left to the supervisor (no interference)', async () => {
    // The detector came up while the network was healthy but the kernel was
    // already down: that failure belongs to the supervisor's crash-restart, so
    // the first healthy tick must not fire any recovery actions.
    const h = createHarness({ online: true, kernelRunning: false })
    await h.tick()
    expect(h.calls).toEqual([])
  })

  it('keeps retrying a failed reconnect on subsequent ticks', async () => {
    const h = createHarness({ online: true })
    await h.tick()
    h.online.value = false
    await h.tick()
    h.online.value = true
    h.startKernelRejects.value = new Error('port race')
    await h.tick()
    // The kernel restart failed, so the proxy re-enable also ran into a dead
    // controller — but BOTH are retried on the next tick.
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel', 'startKernel', 'handleNetworkUp'])
    expect(h.kernelRunning.value).toBe(false)

    h.startKernelRejects.value = null
    await h.tick()
    expect(h.calls).toEqual([
      'handleNetworkDown',
      'stopKernel',
      'startKernel',
      'handleNetworkUp',
      'startKernel',
      'handleNetworkUp'
    ])
    expect(h.kernelRunning.value).toBe(true)

    // Healed: subsequent healthy ticks are no-ops.
    await h.tick()
    expect(h.calls).toHaveLength(6)
  })

  it('ignores virtual/loopback interfaces when judging connectivity', async () => {
    const h = createHarness({ online: true })
    // The harness injects eth0; simulate waking up with ONLY a TUN interface.
    const anyDetector = h.detector as unknown as { options: { networkInterfacesFn: () => unknown } }
    anyDetector.options.networkInterfacesFn = () => ({ utun3: iface() })
    await h.tick()
    // No real interface → treated as offline.
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel'])
  })

  it('offline with no owned proxy is a safe no-op for the proxy path', async () => {
    const h = createHarness({ online: false, kernelRunning: false })
    // sawOfflineFirst arms only when the kernel was stopped by US; with no
    // kernel and no proxy, the offline tick still marks the outage.
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown'])
  })
})
