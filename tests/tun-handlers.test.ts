import { beforeEach, describe, expect, it } from 'vitest'
import { IPC } from '../src/shared/ipc'
import { brand } from '../src/shared/brand'
import { buildIpcHandlers } from '../src/main/ipc/handlers'
import { createFakeContainer } from '../src/main/testing/fake-container'

describe('TUN IPC exclusivity', () => {
  let container: ReturnType<typeof createFakeContainer>
  beforeEach(() => { container = createFakeContainer(brand) })

  it('enables TUN only while the safe kernel and system proxy are stopped', async () => {
    const handlers = buildIpcHandlers(container.deps)
    await handlers[IPC.tunEnable]({})
    expect(container.tun.enableCalls).toBe(1)

    container.kernel.status.phase = 'running'
    await expect(handlers[IPC.tunEnable]({})).rejects.toThrow(/Stop the safe kernel/)
    container.kernel.status.phase = 'stopped'
    container.systemProxy.status.phase = 'enabled'
    await expect(handlers[IPC.tunEnable]({})).rejects.toThrow(/Stop the safe kernel/)
    expect(container.tun.enableCalls).toBe(1)
  })

  it('blocks safe-kernel and system-proxy enable while TUN owns networking', async () => {
    container.tun.status.phase = 'active'
    const handlers = buildIpcHandlers(container.deps)
    await expect(handlers[IPC.kernelStart]({})).rejects.toThrow(/Disable TUN/)
    await expect(handlers[IPC.systemProxyEnable]({})).rejects.toThrow(/Disable TUN/)
    expect(container.kernel.startCalls).toBe(0)
    expect(container.systemProxy.enableCalls).toBe(0)
  })

  it('always permits a renderer-independent disable attempt', async () => {
    container.tun.status.phase = 'restore-failed'
    await buildIpcHandlers(container.deps)[IPC.tunDisable]({})
    expect(container.tun.disableCalls).toBe(1)
  })
})
