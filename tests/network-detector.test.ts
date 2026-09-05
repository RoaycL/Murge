import { describe, it, expect } from 'vitest'
import { NetworkDetector, type NetworkDetectorGateway } from '../src/main/services/network-detector'

type GatewayLog = Array<
  | 'handleNetworkUp'
  | 'handleNetworkDown'
  | 'startKernel'
  | 'startTun'
  | 'stopKernel'
>

interface Harness {
  detector: NetworkDetector
  online: { value: boolean }
  runMode: { value: 'stopped' | 'kernel' | 'tun' }
  calls: GatewayLog
  startKernelRejects: { value: Error | null }
  startTunRejects: { value: Error | null }
  networkUpRejects: { value: Error | null }
  networkUpResult: { value: 'reenabled' | 'idle' | 'failed' }
  networkDownResult: { value: 'disabled' | 'idle' | 'failed' }
  stopKernelRejects: { value: Error | null }
  tick(): Promise<void>
  stop(): void
}

function createHarness(options: { online?: boolean; kernelRunning?: boolean; runMode?: 'stopped' | 'kernel' | 'tun' } = {}): Harness {
  const online = { value: options.online ?? true }
  const runMode = { value: options.runMode ?? (options.kernelRunning === false ? 'stopped' : 'kernel') }
  const calls: GatewayLog = []
  const startKernelRejects = { value: null as Error | null }
  const startTunRejects = { value: null as Error | null }
  const networkUpRejects = { value: null as Error | null }
  const networkUpResult: Harness['networkUpResult'] = { value: 'reenabled' }
  const networkDownResult: Harness['networkDownResult'] = { value: 'disabled' }
  const stopKernelRejects = { value: null as Error | null }
  const gateway: NetworkDetectorGateway = {
    getRunMode: () => runMode.value,
    startKernel: () => {
      calls.push('startKernel')
      if (startKernelRejects.value) return Promise.reject(startKernelRejects.value)
      runMode.value = 'kernel'
      return Promise.resolve(undefined)
    },
    startTun: () => {
      calls.push('startTun')
      if (startTunRejects.value) return Promise.reject(startTunRejects.value)
      runMode.value = 'tun'
      return Promise.resolve(undefined)
    },
    stopKernel: () => {
      calls.push('stopKernel')
      if (stopKernelRejects.value) return Promise.reject(stopKernelRejects.value)
      runMode.value = 'stopped'
      return Promise.resolve(undefined)
    },
    handleNetworkDown: () => {
      calls.push('handleNetworkDown')
      return Promise.resolve(networkDownResult.value)
    },
    handleNetworkUp: () => {
      calls.push('handleNetworkUp')
      if (networkUpRejects.value) return Promise.reject(networkUpRejects.value)
      return Promise.resolve(networkUpResult.value)
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
    runMode,
    calls,
    startKernelRejects,
    startTunRejects,
    networkUpRejects,
    networkUpResult,
    networkDownResult,
    stopKernelRejects,
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
    // A failed kernel restart must not point the OS proxy at a dead listener.
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel', 'startKernel'])
    expect(h.runMode.value).toBe('stopped')

    h.startKernelRejects.value = null
    await h.tick()
    expect(h.calls).toEqual([
      'handleNetworkDown',
      'stopKernel',
      'startKernel',
      'startKernel',
      'handleNetworkUp'
    ])
    expect(h.runMode.value).toBe('kernel')

    // Healed: subsequent healthy ticks are no-ops.
    await h.tick()
    expect(h.calls).toHaveLength(5)
  })

  it('keeps retrying proxy restoration after the host has recovered', async () => {
    const h = createHarness({ online: true })
    h.online.value = false
    await h.tick()
    h.online.value = true
    h.networkUpRejects.value = new Error('registry busy')
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel', 'startKernel', 'handleNetworkUp'])

    h.networkUpRejects.value = null
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel', 'startKernel', 'handleNetworkUp', 'handleNetworkUp'])
  })

  it('keeps retrying when proxy recovery reports failure without throwing', async () => {
    const h = createHarness({ online: true })
    h.online.value = false
    await h.tick()
    h.online.value = true
    h.networkUpResult.value = 'failed'
    await h.tick()
    await h.tick()
    expect(h.calls.filter((call) => call === 'handleNetworkUp')).toHaveLength(2)

    h.networkUpResult.value = 'reenabled'
    await h.tick()
    await h.tick()
    expect(h.calls.filter((call) => call === 'handleNetworkUp')).toHaveLength(3)
  })

  it('does not stop the live host until a failed proxy disable is retried successfully', async () => {
    const h = createHarness({ online: true, runMode: 'tun' })
    h.online.value = false
    h.networkDownResult.value = 'failed'
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown'])
    expect(h.runMode.value).toBe('tun')

    h.networkDownResult.value = 'disabled'
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'handleNetworkDown', 'stopKernel'])
    expect(h.runMode.value).toBe('stopped')
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

  it('restores TUN rather than silently downgrading to the main kernel', async () => {
    const h = createHarness({ online: true, runMode: 'tun' })
    h.online.value = false
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel'])
    expect(h.runMode.value).toBe('stopped')

    h.online.value = true
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel', 'startTun', 'handleNetworkUp'])
    expect(h.runMode.value).toBe('tun')
  })

  it('does not forget the prior TUN mode during an online/offline recovery flap', async () => {
    const h = createHarness({ online: true, runMode: 'tun' })
    h.online.value = false
    await h.tick()
    h.online.value = true
    h.startTunRejects.value = new Error('adapter busy')
    await h.tick()
    expect(h.calls).toContain('startTun')

    h.online.value = false
    await h.tick()
    h.online.value = true
    h.startTunRejects.value = null
    await h.tick()
    expect(h.calls.filter((call) => call === 'startTun')).toHaveLength(2)
    expect(h.runMode.value).toBe('tun')
  })

  it('offline with no owned proxy is a safe no-op for the proxy path', async () => {
    const h = createHarness({ online: false, kernelRunning: false })
    // sawOfflineFirst arms only when the kernel was stopped by US; with no
    // kernel and no proxy, the offline tick still marks the outage.
    await h.tick()
    expect(h.calls).toEqual(['handleNetworkDown'])
  })

  it('retries a failed stopKernel on the next offline tick (no blackhole)', async () => {
    const h = createHarness({ online: true, runMode: 'tun' })
    h.online.value = false
    h.stopKernelRejects.value = new Error('supervisor busy')
    await h.tick()
    // handleNetworkDown runs once; the failed stop is NOT latched away.
    expect(h.calls).toEqual(['handleNetworkDown', 'stopKernel'])

    h.stopKernelRejects.value = null
    await h.tick()
    // The second offline tick retries the stop and this time it succeeds.
    expect(h.calls.filter((call) => call === 'stopKernel')).toHaveLength(2)
    expect(h.runMode.value).toBe('stopped')
  })
})
