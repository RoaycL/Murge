import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLatencyStore } from '../src/renderer/src/stores/latency'

const sample = (proxyMs: number | null) => ({ gatewayMs: 1, dnsMs: 20, proxyMs, proxyNode: proxyMs == null ? null : 'Node' })

describe('latency store after kernel start', () => {
  let internetLatency: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    internetLatency = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = { desktop: { mihomo: { internetLatency } } }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries once when the first post-start sample has no proxy number', async () => {
    internetLatency.mockResolvedValueOnce(sample(null)).mockResolvedValueOnce(sample(89))
    const store = useLatencyStore()
    const done = store.probeAfterKernelStart(3000)
    await vi.advanceTimersByTimeAsync(3000)
    await done
    expect(internetLatency).toHaveBeenCalledTimes(2)
    expect(store.proxyMs).toBe(89)
    expect(store.state).toBe('ready')
  })

  it('does not retry when the first sample already measured the proxy', async () => {
    internetLatency.mockResolvedValue(sample(50))
    const store = useLatencyStore()
    await store.probeAfterKernelStart(3000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(internetLatency).toHaveBeenCalledTimes(1)
  })

  it('skips the retry when a newer probe already ran', async () => {
    internetLatency.mockResolvedValueOnce(sample(null)).mockResolvedValue(sample(70))
    const store = useLatencyStore()
    const done = store.probeAfterKernelStart(3000)
    await vi.advanceTimersByTimeAsync(0)
    await store.probe()
    await vi.advanceTimersByTimeAsync(3000)
    await done
    expect(internetLatency).toHaveBeenCalledTimes(2)
    expect(store.proxyMs).toBe(70)
  })
})
