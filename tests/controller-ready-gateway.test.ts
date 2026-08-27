import { describe, expect, it, vi } from 'vitest'
import { ControllerReadyKernelGateway } from '../src/main/kernel/controller-ready-gateway'
import { ProtocolErrorCode } from '../src/shared/protocol-errors'
import type { KernelStatus } from '../src/shared/runtime'

const running: KernelStatus = {
  phase: 'running', pid: 42, version: 'test', controllerUrl: null,
  startedAt: '2026-01-01T00:00:00.000Z', lastError: null
}
const stopped: KernelStatus = {
  phase: 'stopped', pid: null, version: null, controllerUrl: null,
  startedAt: null, lastError: null
}

function fakeKernel() {
  return {
    getStatus: vi.fn(() => running),
    start: vi.fn(async () => running),
    stop: vi.fn(async () => stopped),
    onStatus: vi.fn(() => () => undefined)
  }
}

describe('ControllerReadyKernelGateway', () => {
  it('resolves start only after the authenticated controller answers', async () => {
    const kernel = fakeKernel()
    const client = { getVersion: vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue({ version: '1' }) }
    const gateway = new ControllerReadyKernelGateway(kernel, client as never, { timeoutMs: 100, retryMs: 1 })

    await expect(gateway.start()).resolves.toEqual(running)
    expect(client.getVersion).toHaveBeenCalledTimes(2)
    expect(kernel.stop).not.toHaveBeenCalled()
  })

  it('stops a half-ready process and returns a typed timeout', async () => {
    const kernel = fakeKernel()
    const client = { getVersion: vi.fn().mockRejectedValue(new Error('not ready')) }
    const gateway = new ControllerReadyKernelGateway(kernel, client as never, { timeoutMs: 5, retryMs: 1 })

    const error = await gateway.start().catch((value) => value)
    expect(error.code).toBe(ProtocolErrorCode.KERNEL_START_TIMEOUT)
    expect(kernel.stop).toHaveBeenCalledOnce()
  })
})
