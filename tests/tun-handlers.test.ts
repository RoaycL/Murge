import { beforeEach, describe, expect, it } from 'vitest'
import { IPC } from '../src/shared/ipc'
import { brand } from '../src/shared/brand'
import { buildIpcHandlers } from '../src/main/ipc/handlers'
import { createFakeContainer } from '../src/main/testing/fake-container'

describe('TUN IPC single-kernel mode switch', () => {
  let container: ReturnType<typeof createFakeContainer>
  beforeEach(() => { container = createFakeContainer(brand) })

  it('enables TUN with the kernel stopped, and auto-stops it otherwise', async () => {
    const handlers = buildIpcHandlers(container.deps)
    await handlers[IPC.tunEnable]({})
    expect(container.tun.enableCalls).toBe(1)
    expect(container.kernel.stopCalls).toBe(0)

    // In the single-kernel model enabling TUN is a mode switch on the SAME kernel:
    // whenever the ordinary host is live, it is stopped first so the elevated child
    // can rebind the unified ports. Real wiring uses `prepareTunEnable` (no proxy
    // restore); the fakes fall back to a legacy stop, which is still a stop.
    container.kernel.status.phase = 'running'
    await handlers[IPC.tunEnable]({})
    expect(container.kernel.stopCalls).toBe(1)
    expect(container.tun.enableCalls).toBe(2)
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
