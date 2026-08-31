import { describe, it, expect, vi } from 'vitest'
import { reloadKernelForActiveProfile } from '../src/main/system-proxy/reload-kernel'
import type { KernelStatus } from '../src/shared/runtime'
import type { SystemProxyStatus } from '../src/shared/system-proxy'

const RUNNING: KernelStatus = { phase: 'running', pid: 1, version: '1.18.0', controllerUrl: 'http://127.0.0.1:9090', startedAt: Date.now(), lastError: null }
const STOPPED: KernelStatus = { phase: 'stopped', pid: null, version: null, controllerUrl: null, startedAt: null, lastError: null }
const STARTING: KernelStatus = { ...RUNNING, phase: 'starting', pid: null }

const PROXY_DISABLED: SystemProxyStatus = { supported: true, phase: 'disabled', address: null, port: null, errorMessage: null, conflictDetail: null, updatedAt: '' }
const PROXY_ENABLED: SystemProxyStatus = { supported: true, phase: 'enabled', address: '127.0.0.1', port: 34567, errorMessage: null, conflictDetail: null, updatedAt: '' }

function deps(status: KernelStatus, proxyStatus: SystemProxyStatus) {
  const order: string[] = []
  const kernel = {
    getStatus: vi.fn(async () => ({ ...status })),
    start: vi.fn(async () => { order.push('start'); return { ...status } }),
    stop: vi.fn(async () => { order.push('stop'); return { ...status } })
  }
  const systemProxy = {
    getStatus: vi.fn(() => ({ ...proxyStatus })),
    enable: vi.fn(async () => { order.push('enable'); return { ...proxyStatus } })
  }
  return { kernel, systemProxy, order }
}

describe('reloadKernelForActiveProfile', () => {
  it('restarts a running kernel and re-enables an owned system proxy', async () => {
    const { kernel, systemProxy, order } = deps(RUNNING, PROXY_ENABLED)
    await reloadKernelForActiveProfile({ kernel, systemProxy })

    expect(kernel.stop).toHaveBeenCalledTimes(1)
    expect(kernel.start).toHaveBeenCalledTimes(1)
    expect(systemProxy.enable).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['stop', 'start', 'enable'])
  })

  it('restarts a running kernel but leaves a disabled system proxy alone', async () => {
    const { kernel, systemProxy, order } = deps(RUNNING, PROXY_DISABLED)
    await reloadKernelForActiveProfile({ kernel, systemProxy })

    expect(kernel.stop).toHaveBeenCalledTimes(1)
    expect(kernel.start).toHaveBeenCalledTimes(1)
    expect(systemProxy.enable).not.toHaveBeenCalled()
    expect(order).toEqual(['stop', 'start'])
  })

  it('does nothing when the kernel is stopped', async () => {
    const { kernel, systemProxy } = deps(STOPPED, PROXY_ENABLED)
    await reloadKernelForActiveProfile({ kernel, systemProxy })

    expect(kernel.stop).not.toHaveBeenCalled()
    expect(kernel.start).not.toHaveBeenCalled()
    expect(systemProxy.enable).not.toHaveBeenCalled()
  })

  it('restarts while the kernel is still starting', async () => {
    const { kernel, systemProxy, order } = deps(STARTING, PROXY_ENABLED)
    await reloadKernelForActiveProfile({ kernel, systemProxy })

    expect(order).toEqual(['stop', 'start', 'enable'])
  })

  it('propagates a failed start and never re-enables the proxy', async () => {
    const { kernel, systemProxy } = deps(RUNNING, PROXY_ENABLED)
    kernel.start.mockRejectedValueOnce(new Error('spawn failed'))

    await expect(reloadKernelForActiveProfile({ kernel, systemProxy })).rejects.toThrow('spawn failed')
    expect(kernel.stop).toHaveBeenCalledTimes(1)
    expect(systemProxy.enable).not.toHaveBeenCalled()
  })
})
