import { describe, expect, it } from 'vitest'
import type { KernelGateway } from '../src/shared/gateways'
import type { KernelStatus } from '../src/shared/runtime'
import type { TunStatus } from '../src/shared/tun'
import type { KernelStopPrecondition } from '../src/main/system-proxy/ordered-kernel-gateway'
import { SingleKernelGateway, LateBoundKernelGateway } from '../src/main/kernel/single-kernel-gateway'
import { ProtocolError } from '../src/shared/protocol-errors'

const RUNNING: KernelStatus = { phase: 'running', pid: 412, version: 'v1.19.30', controllerUrl: null, startedAt: 0, lastError: null }
const STOPPED: KernelStatus = { phase: 'stopped', pid: null, version: null, controllerUrl: null, startedAt: null, lastError: null }

function makeKernel(initial: KernelStatus): KernelGateway & { startCalls: number; stopCalls: number; current: KernelStatus; emitStatus: (s: KernelStatus) => void } {
  let current = initial
  let startCalls = 0
  let stopCalls = 0
  const listeners = new Set<(s: KernelStatus) => void>()
  const emit = (s: KernelStatus): void => { current = s; for (const l of listeners) l({ ...s }) }
  return {
    get current() { return current },
    get startCalls() { return startCalls },
    get stopCalls() { return stopCalls },
    getStatus: () => Promise.resolve({ ...current }),
    start: () => { startCalls += 1; current = RUNNING; emit(RUNNING); return Promise.resolve({ ...current }) },
    stop: () => { stopCalls += 1; current = STOPPED; emit(STOPPED); return Promise.resolve({ ...current }) },
    onStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    emitStatus: emit
  }
}

function makeTun(initial: TunStatus): { getStatus: () => TunStatus; onStatus: (l: (s: TunStatus) => void) => () => void; emergencyDisableCalls: number; current: TunStatus; emitStatus: (s: TunStatus) => void; emergencyDisable: () => Promise<void> } {
  let current = initial
  let emergencyDisableCalls = 0
  const listeners = new Set<(s: TunStatus) => void>()
  const emit = (s: TunStatus): void => { current = s; for (const l of listeners) l({ ...s }) }
  return {
    get current() { return current },
    get emergencyDisableCalls() { return emergencyDisableCalls },
    getStatus: () => ({ ...current }),
    onStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    emitStatus: emit,
    async emergencyDisable(): Promise<void> {
      emergencyDisableCalls += 1
      emit(IDLE_TUN)
    }
  }
}

function makePrecondition(): KernelStopPrecondition & { restores: number } {
  let restores = 0
  return {
    get restores() { return restores },
    restoreBeforeKernelUnavailable: () => { restores += 1; return Promise.resolve() }
  }
}

const ACTIVE_TUN: TunStatus = { supported: true, phase: 'active', errorMessage: null, conflictDetail: null, updatedAt: null }
const IDLE_TUN: TunStatus = { supported: true, phase: 'configured', errorMessage: null, conflictDetail: null, updatedAt: null }

function setup(opts: { main?: ReturnType<typeof makeKernel>; rawMain?: ReturnType<typeof makeKernel>; tun?: ReturnType<typeof makeTun>; systemProxy?: ReturnType<typeof makePrecondition>; controllerUrl?: string | null } = {}) {
  const main = opts.main ?? makeKernel(STOPPED)
  const rawMain = opts.rawMain ?? makeKernel(STOPPED)
  const tun = opts.tun ?? makeTun(IDLE_TUN)
  const systemProxy = opts.systemProxy ?? makePrecondition()
  const controllerUrl = opts.controllerUrl ?? 'http://127.0.0.1:9090'
  const gateway = new SingleKernelGateway(main, rawMain, tun, systemProxy, controllerUrl)
  return { main, rawMain, tun, systemProxy, controllerUrl, gateway }
}

describe('SingleKernelGateway', () => {
  it('reports running + unified controllerUrl while TUN is serving', async () => {
    const { gateway } = setup({ main: makeKernel(STOPPED), tun: makeTun(ACTIVE_TUN) })
    const status = await gateway.getStatus()
    expect(status.phase).toBe('running')
    expect(status.controllerUrl).toBe('http://127.0.0.1:9090')
  })

  it('delegates getStatus to the main kernel when TUN is not serving', async () => {
    const { gateway } = setup({ main: makeKernel(RUNNING), tun: makeTun(IDLE_TUN) })
    const status = await gateway.getStatus()
    expect(status.pid).toBe(412)
    expect(status.phase).toBe('running')
  })

  it('start() is a no-op while TUN is serving (does not spawn a conflicting host)', async () => {
    const main = makeKernel(STOPPED)
    const { gateway } = setup({ main, tun: makeTun(ACTIVE_TUN) })
    const status = await gateway.start()
    expect(status.phase).toBe('running')
    expect(main.startCalls).toBe(0)
  })

  it('start() delegates to the main kernel when TUN is not serving', async () => {
    const main = makeKernel(STOPPED)
    const { gateway } = setup({ main })
    await gateway.start()
    expect(main.startCalls).toBe(1)
  })

  it('stop() while TUN is serving restores the proxy then disables TUN', async () => {
    const tun = makeTun(ACTIVE_TUN)
    const systemProxy = makePrecondition()
    const { gateway } = setup({ tun, systemProxy })
    const status = await gateway.stop()
    expect(systemProxy.restores).toBe(1)
    expect(tun.emergencyDisableCalls).toBe(1)
    // After the TUN child is torn down and never restarted, the full stop leaves
    // no host serving, so the logical kernel reports stopped.
    expect(status.phase).toBe('stopped')
  })

  it('stop() delegates to the main kernel when TUN is not serving', async () => {
    const main = makeKernel(RUNNING)
    const systemProxy = makePrecondition()
    const { gateway } = setup({ main, systemProxy })
    await gateway.stop()
    expect(main.stopCalls).toBe(1)
    expect(systemProxy.restores).toBe(0)
  })

  it('prepareTunEnable() stops the raw main kernel without restoring the proxy', async () => {
    const rawMain = makeKernel(RUNNING)
    const systemProxy = makePrecondition()
    const { gateway } = setup({ rawMain, systemProxy })
    await gateway.prepareTunEnable()
    expect(rawMain.stopCalls).toBe(1)
    expect(systemProxy.restores).toBe(0)
  })

  it('prepareTunEnable() is a no-op while TUN is already serving', async () => {
    const rawMain = makeKernel(RUNNING)
    const { gateway } = setup({ rawMain, tun: makeTun(ACTIVE_TUN) })
    await gateway.prepareTunEnable()
    expect(rawMain.stopCalls).toBe(0)
  })

  it('resumeAfterTun() restarts the main kernel so the unified ports keep serving', async () => {
    const rawMain = makeKernel(STOPPED)
    const main = makeKernel(STOPPED)
    const { gateway } = setup({ main, rawMain })
    await gateway.resumeAfterTun()
    expect(main.startCalls).toBe(1)
  })

  it('resumeAfterTun() is a no-op when the main kernel is already starting/running', async () => {
    const rawMain = makeKernel(RUNNING)
    const main = makeKernel(RUNNING)
    const { gateway } = setup({ main, rawMain })
    await gateway.resumeAfterTun()
    expect(main.startCalls).toBe(0)
  })

  it('onStatus() re-emits merged running when the TUN child transitions to active', async () => {
    const main = makeKernel(STOPPED)
    const tun = makeTun(IDLE_TUN)
    const { gateway } = setup({ main, tun })
    const seen: KernelStatus[] = []
    gateway.onStatus((s) => seen.push(s))
    // The initial emit is forwarded through a promise, so flush one microtask to
    // collect it before asserting on the TUN transition.
    await Promise.resolve()
    expect(seen[seen.length - 1].phase).toBe('stopped')
    // The TUN child comes up: the merged status must flip to running even though
    // the main kernel stays stopped.
    tun.emitStatus(ACTIVE_TUN)
    await Promise.resolve()
    expect(seen[seen.length - 1].phase).toBe('running')
  })
})

describe('LateBoundKernelGateway', () => {
  it('delegates getStatus to the implementation bound after construction', async () => {
    const real = makeKernel(RUNNING)
    const bound = new LateBoundKernelGateway(() => null)
    bound.set(real)
    const status = await bound.getStatus()
    expect(status.phase).toBe('running')
    expect(status.pid).toBe(412)
  })

  it('also resolves through the provider when implementation is not bound', async () => {
    const real = makeKernel(RUNNING)
    const bound = new LateBoundKernelGateway(() => real)
    const status = await bound.getStatus()
    expect(status.phase).toBe('running')
  })

  it('delegates start/stop/onStatus to the bound gateway', async () => {
    const main = makeKernel(STOPPED)
    const bound = new LateBoundKernelGateway(() => null)
    bound.set(main)
    await bound.start()
    expect(main.startCalls).toBe(1)
    const seen: KernelStatus[] = []
    bound.onStatus((s) => seen.push(s))
    main.emitStatus(RUNNING)
    expect(seen[seen.length - 1].phase).toBe('running')
  })

  it('fails closed (INTERNAL) when neither a provider nor a bound gateway exists', () => {
    const bound = new LateBoundKernelGateway(() => null)
    expect(() => bound.getStatus()).toThrowError(ProtocolError)
  })
})
