import { beforeEach, describe, expect, it } from 'vitest'
import { IPC } from '../src/shared/ipc'
import { brand } from '../src/shared/brand'
import { buildIpcHandlers } from '../src/main/ipc/handlers'
import { createFakeContainer } from '../src/main/testing/fake-container'

/**
 * The IPC handlers are PURE delegates: the injected `kernel`/`tun` gateways are
 * the queued wrappers over the single-kernel model (see
 * src/main/kernel/mode-transition.ts), which owns the whole mode-switch
 * orchestration — prepare-without-proxy-restore, rollback resume, readiness
 * confirmation and the proxy-restore-on-dead-port invariant. The orchestration
 * itself is covered end-to-end in tests/mode-transition.test.ts.
 */
describe('TUN IPC single-kernel mode switch', () => {
  let container: ReturnType<typeof createFakeContainer>
  beforeEach(() => { container = createFakeContainer(brand) })

  it('delegates tunEnable/tunDisable to the injected (queued) TUN gateway', async () => {
    const handlers = buildIpcHandlers(container.deps)
    await handlers[IPC.tunEnable]({})
    expect(container.tun.enableCalls).toBe(1)
    // The handler itself never touches the kernel: the controller inside the
    // queued gateway owns the prepare/stop sequence.
    expect(container.kernel.stopCalls).toBe(0)

    await handlers[IPC.tunDisable]({})
    expect(container.tun.disableCalls).toBe(1)
  })

  it('enables TUN while the system proxy is already owned (coexistence)', async () => {
    // The proxy points at the fixed mixed-port regardless of which host is live, so
    // an owned proxy must not block TUN.
    container.systemProxy.status.phase = 'enabled'
    const handlers = buildIpcHandlers(container.deps)
    await handlers[IPC.tunEnable]({})
    expect(container.tun.enableCalls).toBe(1)
  })

  it('does not reject kernel start while TUN owns networking; the system proxy stays allowed', async () => {
    // Single-kernel model: the merged gateway turns a `kernel.start()` while TUN is
    // live into a no-op (the logical kernel is already running as the elevated
    // child). The raw IPC handler only delegates, so it must not throw.
    container.tun.status.phase = 'active'
    const handlers = buildIpcHandlers(container.deps)
    await expect(handlers[IPC.kernelStart]({})).resolves.toBeDefined()
    // The system proxy may be enabled on top of an active TUN session; the
    // TUN-aware probe resolves it to the unified mixed-port.
    await handlers[IPC.systemProxyEnable]({})
    expect(container.systemProxy.enableCalls).toBe(1)
  })

  it('always permits a renderer-independent disable attempt', async () => {
    container.tun.status.phase = 'restore-failed'
    await buildIpcHandlers(container.deps)[IPC.tunDisable]({})
    expect(container.tun.disableCalls).toBe(1)
  })
})
