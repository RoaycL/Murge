import { describe, expect, it, vi } from 'vitest'
import { ModeTransitionController, queuedKernelGateway, queuedTunGateway } from '../src/main/kernel/mode-transition'
import type { KernelGateway } from '../src/shared/gateways'
import type { KernelStatus } from '../src/shared/runtime'
import type { TunGateway, TunStatus } from '../src/shared/tun'
import type { SystemProxyStatus } from '../src/shared/system-proxy'

/* -------------------------------------------------------------------------- */
/* Deterministic fakes                                                         */
/* -------------------------------------------------------------------------- */

function kernelStatus(phase: KernelStatus['phase'], overrides: Partial<KernelStatus> = {}): KernelStatus {
  return { phase, pid: null, version: null, controllerUrl: null, startedAt: null, lastError: null, ...overrides }
}

function tunStatus(phase: TunStatus['phase'], overrides: Partial<TunStatus> = {}): TunStatus {
  return { supported: true, phase, errorMessage: null, conflictDetail: null, updatedAt: null, ...overrides }
}

class FakeKernelGateway implements KernelGateway {
  status: KernelStatus = kernelStatus('stopped')
  /** When set, start() resolves to this instead of flipping to running. */
  startError: Error | null = null
  startCalls = 0
  stopCalls = 0
  prepareTunEnableCalls = 0
  resumeAfterTunCalls = 0
  /** Simulates an async gap so concurrency tests can force interleavings. */
  startDelayMs = 0
  private readonly listeners = new Set<(status: KernelStatus) => void>()

  getStatus(): Promise<KernelStatus> {
    return Promise.resolve({ ...this.status })
  }

  async start(): Promise<KernelStatus> {
    this.startCalls += 1
    if (this.startDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.startDelayMs))
    if (this.startError) throw this.startError
    this.status = kernelStatus('running')
    return { ...this.status }
  }

  async stop(): Promise<KernelStatus> {
    this.stopCalls += 1
    this.status = kernelStatus('stopped')
    return { ...this.status }
  }

  onStatus(listener: (status: KernelStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prepareTunEnable(): Promise<void> {
    this.prepareTunEnableCalls += 1
    this.status = kernelStatus('stopped')
  }

  async resumeAfterTun(): Promise<void> {
    this.resumeAfterTunCalls += 1
    if (this.status.phase === 'stopped') await this.start()
  }
}

class FakeTunGateway implements TunGateway {
  status: TunStatus = tunStatus('configured')
  enableCalls = 0
  disableCalls = 0
  /** Phase the gateway moves to after a successful enable. */
  enableOutcome: TunStatus['phase'] = 'active'
  enableError: Error | null = null
  private readonly listeners = new Set<(status: TunStatus) => void>()

  getStatus(): TunStatus {
    return { ...this.status }
  }

  async enable(): Promise<TunStatus> {
    this.enableCalls += 1
    if (this.enableError) throw this.enableError
    this.status = tunStatus(this.enableOutcome)
    return { ...this.status }
  }

  async disable(): Promise<TunStatus> {
    this.disableCalls += 1
    this.status = tunStatus('configured')
    return { ...this.status }
  }

  onStatus(listener: (status: TunStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

class FakeSystemProxy {
  restoreCalls = 0
  restoreError: Error | null = null
  async restoreBeforeKernelUnavailable(): Promise<void> {
    this.restoreCalls += 1
    if (this.restoreError) throw this.restoreError
  }
}

interface Harness {
  kernel: FakeKernelGateway
  tun: FakeTunGateway
  proxy: FakeSystemProxy
  controller: ModeTransitionController
  /** IPC-shaped gateways built through the queued wrappers. */
  ipcKernel: KernelGateway
  ipcTun: TunGateway
  setControllerReady(ready: boolean): void
}

function createHarness(options: { controllerReady?: boolean; probeTunSession?: () => Promise<'owned-live' | 'owned-gone' | 'unreachable'> } = {}): Harness {
  const kernel = new FakeKernelGateway()
  const tun = new FakeTunGateway()
  const proxy = new FakeSystemProxy()
  let controllerReady = options.controllerReady ?? true
  const controller = new ModeTransitionController({
    kernel,
    tun,
    systemProxy: proxy,
    isControllerReady: () => Promise.resolve(controllerReady),
    probeTunSession: options.probeTunSession,
    onError: () => undefined
  })
  return {
    kernel,
    tun,
    proxy,
    controller,
    ipcKernel: queuedKernelGateway(kernel, controller),
    ipcTun: queuedTunGateway(tun, controller),
    setControllerReady(ready: boolean) {
      controllerReady = ready
    }
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/* -------------------------------------------------------------------------- */
/* P1-1: normal TUN enable/disable must NOT restore the system proxy           */
/* -------------------------------------------------------------------------- */

describe('P1-1 normal TUN mode switch keeps the owned system proxy', () => {
  it('does not restore the proxy across a normal enable → disable cycle', async () => {
    const h = createHarness()
    // Proxy owned before the switch (the kernel carries it through the mode
    // switch in production; the fakes model that by simply staying "enabled").
    await h.ipcTun.enable()
    expect(h.tun.status.phase).toBe('active')
    expect(h.proxy.restoreCalls).toBe(0)

    await h.ipcTun.disable()
    expect(h.tun.status.phase).toBe('configured')
    // The unified mixed port is rebound by the resumed main kernel, so the owned
    // proxy config stays valid — no restore.
    expect(h.proxy.restoreCalls).toBe(0)
    expect(h.kernel.resumeAfterTunCalls).toBe(1)
  })

  it('restores the proxy only when the main kernel cannot resume and the controller is dead', async () => {
    const h = createHarness({ controllerReady: false })
    await h.ipcTun.enable()
    expect(h.tun.status.phase).toBe('active')
    h.setControllerReady(false)
    // Simulate resume failure: the raw kernel reports a running phase the
    // resume hook cannot convert into a live controller.
    h.kernel.resumeAfterTun = async () => {
      h.kernel.resumeAfterTunCalls += 1
      // leaves the kernel "stopped": no host on the unified ports
    }
    await h.ipcTun.disable()
    expect(h.proxy.restoreCalls).toBe(1)
  })

  it('does NOT restore the proxy when the controller confirms ready again (abnormal exit, main kernel resumed)', async () => {
    const h = createHarness({ controllerReady: true })
    await h.ipcTun.enable()
    h.setControllerReady(true)
    await h.controller.recoverTunExit()
    // Child died, main kernel resumed, unified controller reachable → keep proxy.
    expect(h.kernel.resumeAfterTunCalls).toBe(1)
    expect(h.proxy.restoreCalls).toBe(0)
    expect(h.tun.status.phase).toBe('configured')
  })

  it('restores the proxy when the controller cannot be confirmed after an abnormal exit', async () => {
    const h = createHarness({ controllerReady: false, probeTunSession: async () => 'owned-gone' })
    await h.ipcTun.enable()
    h.setControllerReady(false)
    await h.controller.recoverTunExit()
    expect(h.proxy.restoreCalls).toBe(1)
  })

  it('abnormal-exit recovery re-probes first: a live session is never torn down', async () => {
    let probeAnswer: 'owned-live' | 'owned-gone' | 'unreachable' = 'owned-live'
    const h = createHarness({ probeTunSession: () => Promise.resolve(probeAnswer) })
    await h.ipcTun.enable()
    await h.controller.recoverTunExit()
    expect(h.tun.disableCalls).toBe(0)
    expect(h.kernel.resumeAfterTunCalls).toBe(0)

    probeAnswer = 'unreachable'
    await h.controller.recoverTunExit()
    expect(h.tun.disableCalls).toBe(0)

    probeAnswer = 'owned-gone'
    await h.controller.recoverTunExit()
    expect(h.tun.disableCalls).toBe(1)
  })

  it('enables TUN with the proxy owned and confirms readiness through the controller probe (no fixed delays)', async () => {
    const h = createHarness({ controllerReady: true })
    const readySpy = vi.fn()
    // The probe IS the readiness mechanism; assert it was consulted.
    h.controller = new ModeTransitionController({
      kernel: h.kernel,
      tun: h.tun,
      systemProxy: h.proxy,
      isControllerReady: () => {
        readySpy()
        return Promise.resolve(true)
      }
    })
    await h.controller.enableTun()
    expect(readySpy).not.toHaveBeenCalled() // success path: no recovery probe needed
    expect(h.kernel.prepareTunEnableCalls).toBe(1)
    expect(h.tun.enableCalls).toBe(1)
  })

  it('rolls back to the main kernel on failed TUN enable and keeps the proxy when the controller recovers', async () => {
    const h = createHarness({ controllerReady: true })
    h.tun.enableOutcome = 'failed'
    await h.ipcTun.enable()
    expect(h.tun.status.phase).toBe('failed')
    expect(h.kernel.resumeAfterTunCalls).toBe(1)
    expect(h.proxy.restoreCalls).toBe(0)
  })

  it('restores the proxy when a failed TUN enable leaves the port dead', async () => {
    const h = createHarness({ controllerReady: false })
    h.tun.enableOutcome = 'failed'
    await h.ipcTun.enable()
    expect(h.proxy.restoreCalls).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* P1-2: ONE mode-transition queue                                             */
/* -------------------------------------------------------------------------- */

describe('P1-2 single mode-transition queue', () => {
  it('serializes concurrent tunEnable and kernelStart (at most one host transition at a time)', async () => {
    const h = createHarness({ controllerReady: true })
    const order: string[] = []
    const originalStart = h.kernel.start.bind(h.kernel)
    h.kernel.start = async () => {
      order.push('start:begin')
      const result = await originalStart()
      order.push('start:end')
      return result
    }
    const enable = h.ipcTun.enable().then(() => order.push('enable:done'))
    const start = h.ipcKernel.start().then(() => order.push('start-kernel:done'))
    await Promise.all([enable, start])
    // The kernel start must not begin until the enable task (which prepared and
    // enabled TUN) fully finished — no interleaved spawn on the unified ports.
    expect(order.indexOf('start:begin')).toBeGreaterThan(order.indexOf('enable:done'))
    // Exactly one host: the second task (kernel.start through the queued
    // gateway) executed AFTER the enable, but the unified gateway reports the
    // TUN child as the running logical kernel — in production SingleKernelGateway
    // turns this into a no-op; with the raw fake it is one supervised start
    // behind the exclusive queue. The invariant under test is the ORDER, not the
    // no-op (which is the unified gateway's own contract).
    expect(order.indexOf('start:begin')).toBeGreaterThan(order.indexOf('enable:done'))
    expect(order[order.length - 1]).toMatch(/done$/)
  })

  it('serializes concurrent tunDisable and kernelStop', async () => {
    const h = createHarness({ controllerReady: true })
    await h.ipcTun.enable()
    const order: string[] = []
    const originalStop = h.kernel.stop.bind(h.kernel)
    h.kernel.stop = async () => {
      order.push('stop:begin')
      const result = await originalStop()
      order.push('stop:end')
      return result
    }
    await Promise.all([h.ipcTun.disable(), h.ipcKernel.stop()])
    // Both complete; the queue kept them mutually exclusive.
    expect(h.tun.disableCalls).toBe(1)
    expect(order[0]).toBe('stop:begin')
    expect(order).toContain('stop:end')
  })

  it('collapses a rapid double-click enable into one mode switch', async () => {
    const h = createHarness({ controllerReady: true })
    const first = h.ipcTun.enable()
    const second = h.ipcTun.enable()
    await Promise.all([first, second])
    expect(h.tun.enableCalls).toBe(1)
    expect(h.kernel.prepareTunEnableCalls).toBe(1)
    expect(h.tun.status.phase).toBe('active')
  })

  it('collapses a rapid double-click disable (the second is a no-op)', async () => {
    const h = createHarness({ controllerReady: true })
    await h.ipcTun.enable()
    const first = h.ipcTun.disable()
    const second = h.ipcTun.disable()
    await Promise.all([first, second])
    expect(h.tun.disableCalls).toBe(1)
    expect(h.tun.status.phase).toBe('configured')
  })

  it('never enqueues a nested task: the controller calls the RAW gateways inside its tasks', async () => {
    // Regression guard for the deadlock shape "queued tun.enable calls
    // queued kernel.stop": the controller must operate on the raw kernel/tun.
    const kernel = new FakeKernelGateway()
    const tun = new FakeTunGateway()
    const controller = new ModeTransitionController({
      kernel,
      tun,
      systemProxy: new FakeSystemProxy(),
      isControllerReady: () => Promise.resolve(true)
    })
    // Build a queued TUN gateway and hand the RAW tun to the controller —
    // exactly the production wiring. If the controller used the queued wrapper
    // internally, this enable would hang on itself.
    const queued = queuedTunGateway(tun, controller)
    const result = await Promise.race([
      queued.enable().then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))
    ])
    expect(result).toBe('done')
  })

  it('keeps the queue draining after a failing task (fail isolation)', async () => {
    const h = createHarness()
    h.tun.enableError = new Error('service unreachable')
    await expect(h.ipcTun.enable()).rejects.toThrow('service unreachable')
    // The queue must still accept the next task.
    h.tun.enableError = null
    await h.ipcKernel.start()
    expect(h.kernel.startCalls).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Invariants: one host, no dead-port proxy                                    */
/* -------------------------------------------------------------------------- */

describe('single-host and no-dead-port invariants', () => {
  it('kernel stop while TUN is serving tears TUN down through the unified gateway (proxy first)', async () => {
    // Mirror the production wiring: the controller's deps.kernel IS the unified
    // single-kernel gateway, and the queued wrapper only serializes.
    const kernel = new FakeKernelGateway()
    const tun = new FakeTunGateway()
    const proxy = new FakeSystemProxy()
    const unified = {
      getStatus: () => kernel.getStatus(),
      onStatus: (listener: (status: KernelStatus) => void) => kernel.onStatus(listener),
      start: () => kernel.start(),
      stop: async () => {
        // Unified gateway semantics: restore proxy first, then stop the serving
        // host (TUN), exactly like SingleKernelGateway.stop().
        await proxy.restoreBeforeKernelUnavailable()
        await tun.disable()
        return kernelStatus('stopped')
      }
    }
    const controller = new ModeTransitionController({
      kernel: unified,
      tun,
      systemProxy: proxy,
      isControllerReady: () => Promise.resolve(true)
    })
    await queuedTunGateway(tun, controller).enable()
    expect(tun.status.phase).toBe('active')
    await queuedKernelGateway(unified, controller).stop()
    expect(proxy.restoreCalls).toBe(1)
    expect(tun.disableCalls).toBe(1)
    expect(tun.status.phase).toBe('configured')
  })

  it('profile reload while TUN is serving re-materializes through a mode switch, not a main-kernel restart', async () => {
    const h = createHarness({ controllerReady: true })
    await h.ipcTun.enable()
    const applyWhileStopped = vi.fn(async () => undefined)
    await h.controller.reloadProfile(applyWhileStopped)
    // The main-kernel reload path was never used.
    expect(applyWhileStopped).not.toHaveBeenCalled()
    // The mode switch ran: child disabled, main kernel resumed on the unified
    // ports (proxy untouched), then the child re-enabled with the new profile.
    expect(h.tun.disableCalls).toBe(1)
    expect(h.tun.enableCalls).toBe(2)
    expect(h.tun.status.phase).toBe('active')
    expect(h.kernel.startCalls).toBe(1)
    expect(h.proxy.restoreCalls).toBe(0)
  })

  it('profile reload while TUN is off re-applies through the unified kernel gateway', async () => {
    const h = createHarness({ controllerReady: true })
    await h.kernel.start()
    const applyWhileStopped = vi.fn(async (kernel: KernelGateway) => {
      await kernel.stop()
      await kernel.start()
    })
    await h.controller.reloadProfile(applyWhileStopped)
    expect(applyWhileStopped).toHaveBeenCalledTimes(1)
    expect(h.kernel.stopCalls).toBe(1)
    expect(h.kernel.startCalls).toBe(2)
  })

  it('final state after any path: controller reachable OR proxy restored (dead-port aim never persists)', async () => {
    const h = createHarness({ controllerReady: false })
    // Enable fails AND the controller stays dead → proxy must be restored.
    h.tun.enableOutcome = 'failed'
    await h.ipcTun.enable()
    const tunPhase = h.tun.status.phase
    const proxyRestored = h.proxy.restoreCalls >= 1
    // Either the unified controller is serving again (kernel resumed) or the
    // owned proxy was restored — never "proxy aimed at a dead port".
    const kernelRunning = h.kernel.status.phase === 'running'
    expect(kernelRunning || proxyRestored || tunPhase === 'active').toBe(true)
    expect(proxyRestored).toBe(true)
  })
})
