import { beforeEach, describe, expect, it } from 'vitest'
import { IPC } from '../src/shared/ipc'
import { brand } from '../src/shared/brand'
import { buildIpcHandlers } from '../src/main/ipc/handlers'
import { createFakeContainer } from '../src/main/testing/fake-container'

describe('TUN IPC exclusivity', () => {
  let container: ReturnType<typeof createFakeContainer>
  beforeEach(() => { container = createFakeContainer(brand) })

  it('enables TUN with the safe kernel stopped, and auto-stops it otherwise', async () => {
    const handlers = buildIpcHandlers(container.deps)
    await handlers[IPC.tunEnable]({})
    expect(container.tun.enableCalls).toBe(1)
    expect(container.kernel.stopCalls).toBe(0)

    // The safe kernel is mutually exclusive with TUN (both run a mihomo and bind
    // a mixed-port). Enabling TUN while it is live auto-stops the kernel first, so
    // the user does not have to stop it by hand; the gateway restores any owned
    // system proxy before the stop.
    container.kernel.status.phase = 'running'
    await handlers[IPC.tunEnable]({})
    expect(container.kernel.stopCalls).toBe(1)
    expect(container.tun.enableCalls).toBe(2)
  })

  it('enables TUN while the system proxy is already owned (coexistence)', async () => {
    // Matches the behaviour of other mihomo desktop clients: the proxy points at
    // whichever mihomo is live, so an owned proxy must not block TUN.
    container.systemProxy.status.phase = 'enabled'
    const handlers = buildIpcHandlers(container.deps)
    await handlers[IPC.tunEnable]({})
    expect(container.tun.enableCalls).toBe(1)
  })

  it('blocks safe-kernel start but allows system-proxy enable while TUN owns networking', async () => {
    container.tun.status.phase = 'active'
    const handlers = buildIpcHandlers(container.deps)
    await expect(handlers[IPC.kernelStart]({})).rejects.toThrow(/Disable TUN/)
    expect(container.kernel.startCalls).toBe(0)
    // The system proxy may be enabled on top of an active TUN session; the
    // TUN-aware probe resolves it to the elevated child's mixed-port.
    await handlers[IPC.systemProxyEnable]({})
    expect(container.systemProxy.enableCalls).toBe(1)
  })

  it('always permits a renderer-independent disable attempt', async () => {
    container.tun.status.phase = 'restore-failed'
    await buildIpcHandlers(container.deps)[IPC.tunDisable]({})
    expect(container.tun.disableCalls).toBe(1)
  })
})
