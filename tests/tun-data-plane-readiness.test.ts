import { describe, expect, it, vi } from 'vitest'
import { waitForTunDataPlaneReady, type TunReadinessClient } from '../src/main/tun/data-plane-readiness'
import { ProtocolErrorCode } from '../src/shared/protocol-errors'

describe('TUN data-plane readiness', () => {
  it('requires a real DIRECT request and falls back to the second endpoint', async () => {
    const client: TunReadinessClient = {
      getVersion: vi.fn(async () => ({ version: 'test' })),
      delayTest: vi.fn()
        .mockRejectedValueOnce(new Error('first endpoint unavailable'))
        .mockResolvedValueOnce({ delay: 12 })
    }
    const controller = new AbortController()

    await waitForTunDataPlaneReady(client, controller.signal, {
      urls: ['https://first.example/generate_204', 'https://second.example/generate_204']
    })

    expect(client.delayTest).toHaveBeenNthCalledWith(1, 'DIRECT', expect.objectContaining({
      url: 'https://first.example/generate_204'
    }))
    expect(client.delayTest).toHaveBeenNthCalledWith(2, 'DIRECT', expect.objectContaining({
      url: 'https://second.example/generate_204'
    }))
  })

  it('stops retrying when the bounded startup signal is aborted', async () => {
    vi.useFakeTimers()
    const client: TunReadinessClient = {
      getVersion: vi.fn(async () => { throw new Error('not ready') }),
      delayTest: vi.fn()
    }
    const controller = new AbortController()
    const pending = waitForTunDataPlaneReady(client, controller.signal, { retryDelayMs: 150 })
    await vi.advanceTimersByTimeAsync(150)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: ProtocolErrorCode.KERNEL_START_TIMEOUT })
    vi.useRealTimers()
  })
})
