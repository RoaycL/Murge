import { describe, expect, it, vi } from 'vitest'
import {
  isRecognizedClashProcess,
  reclaimProxyPorts,
  type ProxyPortOwner,
  type ProxyPortProcessAdapter
} from '../src/main/kernel/proxy-port-reclaimer'

function owner(overrides: Partial<ProxyPortOwner> = {}): ProxyPortOwner {
  return {
    pid: 1200,
    ports: [7890],
    name: 'mihomo.exe',
    executablePath: 'C:\\Program Files\\Clash Party\\mihomo.exe',
    commandLine: 'mihomo.exe -d profile',
    ...overrides
  }
}

describe('proxy port reclaimer', () => {
  it('recognizes explicit Clash-family cores and marked generic cores', () => {
    expect(isRecognizedClashProcess(owner())).toBe(true)
    expect(isRecognizedClashProcess(owner({ name: 'core.exe', executablePath: 'C:\\Apps\\clash-verge\\core.exe' }))).toBe(true)
    expect(isRecognizedClashProcess(owner({ name: 'core.exe', executablePath: 'C:\\BusinessApp\\core.exe', commandLine: '' }))).toBe(false)
  })

  it('terminates a recognized foreign core and verifies the ports are free', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce([owner()])
      .mockResolvedValueOnce([])
    const terminate = vi.fn().mockResolvedValue(undefined)
    const adapter: ProxyPortProcessAdapter = { inspect, terminate }

    await reclaimProxyPorts([7890, 9090, 0, undefined], adapter, 99)

    expect(terminate).toHaveBeenCalledWith(1200)
    expect(inspect).toHaveBeenLastCalledWith([7890, 9090])
  })

  it('never terminates an unknown owner', async () => {
    const adapter: ProxyPortProcessAdapter = {
      inspect: vi.fn().mockResolvedValue([owner({ name: 'node.exe', executablePath: 'C:\\App\\node.exe', commandLine: '' })]),
      terminate: vi.fn()
    }

    await expect(reclaimProxyPorts([7890], adapter, 99)).rejects.toThrow('为避免误关普通程序')
    expect(adapter.terminate).not.toHaveBeenCalled()
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
