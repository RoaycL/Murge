import { describe, expect, it, vi } from 'vitest'
import {
  reclaimProxyPorts,
  proxyPortsOwnedByPid,
  parseWindowsNetstat,
  WindowsProxyPortProcessAdapter,
  type ProxyPortOwner,
  type ProxyPortProcessAdapter
} from '../src/main/kernel/proxy-port-reclaimer'

function owner(overrides: Partial<ProxyPortOwner> = {}): ProxyPortOwner {
  return {
    pid: 1200,
    ports: [7890],
    ...overrides
  }
}

describe('proxy port reclaimer', () => {
  it('terminates the process holding a configured port and verifies the ports are free', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([owner()])
      .mockResolvedValueOnce([])
    const terminate = vi.fn().mockResolvedValue(undefined)
    const adapter: ProxyPortProcessAdapter = { inspect, terminate }

    await reclaimProxyPorts([7890, 9090, 0, undefined], adapter, 99)

    expect(terminate).toHaveBeenCalledWith(1200)
    expect(inspect).toHaveBeenLastCalledWith([7890, 9090])
  })

  it('terminates an unknown program when it holds a configured port', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([owner()])
      .mockResolvedValueOnce([])
    const terminate = vi.fn().mockResolvedValue(undefined)

    await reclaimProxyPorts([7890], { inspect, terminate }, 99)

    expect(terminate).toHaveBeenCalledWith(1200)
  })

  it('rechecks the ports when the listener exits before termination', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([owner()])
      .mockResolvedValueOnce([])
    const terminate = vi.fn().mockRejectedValue(new Error('process not found'))

    await expect(reclaimProxyPorts([7890], { inspect, terminate }, 99, { retryDelayMs: 0 })).resolves.toBeUndefined()
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('reclaims repeated immediate respawns within the bounded takeover window', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([owner({ pid: 1200 })])
      .mockResolvedValueOnce([owner({ pid: 1201 })])
      .mockResolvedValueOnce([])
    const terminate = vi.fn().mockResolvedValue(undefined)

    await reclaimProxyPorts([7890], { inspect, terminate }, 99, { retryDelayMs: 0 })

    expect(terminate).toHaveBeenNthCalledWith(1, 1200)
    expect(terminate).toHaveBeenNthCalledWith(2, 1201)
  })

  it('parses TCP listeners and UDP endpoints without treating established TCP connections as owners', () => {
    expect(parseWindowsNetstat([
      'TCP    127.0.0.1:7890    0.0.0.0:0    LISTENING    1200',
      'TCP    127.0.0.1:7891    1.1.1.1:443  ESTABLISHED  1300',
      'UDP    [::]:7892         *:*                       1200'
    ].join('\r\n'), [7890, 7891, 7892])).toEqual([{ pid: 1200, ports: [7890, 7892] }])
  })

  it.runIf(process.platform === 'win32')('finds a live listener with the production netstat inspector', async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      expect(address).not.toBeNull()
      if (!address || typeof address === 'string') return
      const owners = await new WindowsProxyPortProcessAdapter().inspect([address.port])
      expect(owners).toContainEqual({ pid: process.pid, ports: [address.port] })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10_000)

  it('does not terminate the current process', async () => {
    const adapter: ProxyPortProcessAdapter = {
      inspect: vi.fn().mockResolvedValue([owner({ pid: 88 })]),
      terminate: vi.fn()
    }
    await reclaimProxyPorts([7890], adapter, 88)
    expect(adapter.terminate).not.toHaveBeenCalled()
  })

  it('requires every configured listener to belong to the expected core', async () => {
    const adapter: ProxyPortProcessAdapter = {
      inspect: vi.fn().mockResolvedValue([
        owner({ pid: 42, ports: [7890, 7891] }),
        owner({ pid: 77, ports: [9090] })
      ]),
      terminate: vi.fn()
    }
    await expect(proxyPortsOwnedByPid([7890, 7891], 42, adapter)).resolves.toBe(true)
    await expect(proxyPortsOwnedByPid([7890, 9090], 42, adapter)).resolves.toBe(false)
  })
})
