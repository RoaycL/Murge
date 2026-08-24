import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMihomoStream, MihomoStreamImpl, SOCKET_CLOSED, SOCKET_OPEN, type MihomoSocket } from '../src/main/services/mihomo-stream'
import { startMockMihomoServer, type MockMihomoServerHandle } from '../src/main/testing/mock-mihomo-server'

/** A controllable socket that records listeners and lets a test drive events. */
class FakeSocket implements MihomoSocket {
  readyState = 0
  private readonly listeners = new Map<string, (...args: unknown[]) => void>()
  calls = { close: 0, terminate: 0 }

  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown {
    this.listeners.set(event, listener)
    return this
  }
  removeAllListeners(): void {
    this.listeners.clear()
  }
  close(): void {
    this.calls.close += 1
    this.readyState = SOCKET_CLOSED
    this.emit('close')
  }
  terminate(): void {
    this.calls.terminate += 1
    this.readyState = SOCKET_CLOSED
    this.emit('close')
  }
  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.(...args)
  }
}

const handles: MockMihomoServerHandle[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

describe('MihomoStream backoff', () => {
  it('grows exponentially and clamps to the configured maximum', () => {
    const stream = new MihomoStreamImpl<unknown>({
      url: 'ws://127.0.0.1:1/traffic',
      parse: (raw) => raw,
      options: { backoffMs: 100, maxBackoffMs: 500, jitter: 0 }
    })
    expect(stream.backoffDelay(0)).toBe(100)
    expect(stream.backoffDelay(1)).toBe(200)
    expect(stream.backoffDelay(2)).toBe(400)
    expect(stream.backoffDelay(3)).toBe(500)
    expect(stream.backoffDelay(10)).toBe(500)
  })

  it('applies jitter within the configured bounds', () => {
    const stream = new MihomoStreamImpl<unknown>({
      url: 'ws://127.0.0.1:1/traffic',
      parse: (raw) => raw,
      options: { backoffMs: 1000, maxBackoffMs: 1000, jitter: 0.2 }
    })
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(stream.backoffDelay(0)).toBe(1000) // factor 1.0
    random.mockReturnValue(0)
    expect(stream.backoffDelay(0)).toBe(800) // factor 0.8
    random.mockReturnValue(1)
    expect(stream.backoffDelay(0)).toBe(1200) // factor 1.2
  })
})

describe('MihomoStream transport', () => {
  it('reconnects after a drop without replaying buffered messages', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const factory = () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    }
    const events: number[] = []
    const stream = createMihomoStream<{ up: number }>({
      url: 'ws://127.0.0.1:1/traffic',
      parse: (raw) => raw as { up: number },
      options: { backoffMs: 10, maxBackoffMs: 40, jitter: 0, maxRetries: 5 },
      socketFactory: factory
    })
    stream.subscribe((value) => events.push(value.up))

    expect(sockets).toHaveLength(1)
    sockets[0].emit('open')
    sockets[0].emit('message', Buffer.from(JSON.stringify({ up: 1 })))
    expect(events).toEqual([1])

    // Simulate an unexpected drop; the transport must reconnect.
    sockets[0].emit('close')
    expect(events).toEqual([1]) // nothing replayed
    vi.advanceTimersByTime(10)
    expect(sockets).toHaveLength(2)

    sockets[1].emit('open')
    sockets[1].emit('message', Buffer.from(JSON.stringify({ up: 2 })))
    expect(events).toEqual([1, 2])
  })

  it('reports a connection error immediately on close, not only after retries exhaust', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const factory = () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    }
    const connectionErrors: Error[] = []
    const stream = createMihomoStream<{ up: number }>({
      url: 'ws://127.0.0.1:1/traffic',
      parse: (raw) => raw as { up: number },
      options: { backoffMs: 10, maxBackoffMs: 40, jitter: 0, maxRetries: 5 },
      onConnectionError: (error) => connectionErrors.push(error as Error),
      socketFactory: factory
    })
    stream.subscribe(() => undefined)
    sockets[0].emit('open')

    // An unsolicited close must notify the upper layer right away.
    sockets[0].emit('close')
    expect(connectionErrors).toHaveLength(1)

    // It must still schedule a reconnect rather than giving up.
    vi.advanceTimersByTime(10)
    expect(sockets).toHaveLength(2)
  })

  it('removes only the unsubscribed listener (no leaks)', () => {
    const sockets: FakeSocket[] = []
    const factory = () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    }
    const stream = createMihomoStream<{ up: number }>({
      url: 'ws://127.0.0.1:1/traffic',
      parse: (raw) => raw as { up: number },
      socketFactory: factory
    })
    const alice: number[] = []
    const bob: number[] = []
    const unsubscribeAlice = stream.subscribe((value) => alice.push(value.up))
    stream.subscribe((value) => bob.push(value.up))

    sockets[0].emit('open')
    sockets[0].emit('message', Buffer.from(JSON.stringify({ up: 1 })))
    expect(alice).toEqual([1])
    expect(bob).toEqual([1])

    unsubscribeAlice()
    sockets[0].emit('message', Buffer.from(JSON.stringify({ up: 2 })))
    // alice was removed, so only bob keeps receiving.
    expect(alice).toEqual([1])
    expect(bob).toEqual([1, 2])
  })

  it('drops malformed messages without crashing and reports a parse error', () => {
    const sockets: FakeSocket[] = []
    const factory = () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    }
    const events: number[] = []
    const parseErrors: number[] = []
    const stream = createMihomoStream<{ up: number }>({
      url: 'ws://127.0.0.1:1/traffic',
      parse: (raw) => {
        const value = raw as { up?: number }
        if (typeof value.up !== 'number') throw new Error('bad up field')
        return value as { up: number }
      },
      onParseError: (error) => parseErrors.push((error as Error).message.length),
      socketFactory: factory
    })
    stream.subscribe((value) => events.push(value.up))

    sockets[0].emit('open')
    sockets[0].emit('message', Buffer.from('not json'))
    sockets[0].emit('message', Buffer.from(JSON.stringify({ up: 'oops' })))
    sockets[0].emit('message', Buffer.from(JSON.stringify({ up: 7 })))
    expect(events).toEqual([7])
    expect(parseErrors).toHaveLength(2)
  })

  it('renders live traffic through the real mock server', async () => {
    const server = await startMockMihomoServer({ trafficIntervalMs: 25 })
    handles.push(server)
    const samples: Array<{ up: number }> = []
    const stream = createMihomoStream<{ up: number }>({
      url: `${server.wsBaseUrl}/traffic`,
      parse: (raw) => raw as { up: number }
    })
    stream.subscribe((value) => samples.push(value))
    await vi.waitFor(() => expect(samples.length).toBeGreaterThan(0), { timeout: 3000 })
    expect(samples[0].up).toBeGreaterThanOrEqual(0)
    stream.close()
  })
})
