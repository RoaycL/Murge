import { describe, expect, it, vi } from 'vitest'
import {
  reclaimProxyPorts,
  WINDOWS_PORT_INSPECT_SCRIPT,
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

  it('inspects both TCP listeners and UDP endpoints', () => {
    expect(WINDOWS_PORT_INSPECT_SCRIPT).toContain('Get-NetTCPConnection')
    expect(WINDOWS_PORT_INSPECT_SCRIPT).toContain('Get-NetUDPEndpoint')
  })

  it('does not terminate the current process', async () => {
    const adapter: ProxyPortProcessAdapter = {
      inspect: vi.fn().mockResolvedValue([owner({ pid: 88 })]),
      terminate: vi.fn()
    }
    await reclaimProxyPorts([7890], adapter, 88)
    expect(adapter.terminate).not.toHaveBeenCalled()
  })
})
