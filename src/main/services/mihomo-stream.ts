import { WebSocket } from 'ws'

/**
 * Shared WebSocket transport for a single mihomo stream (`/traffic`, `/logs`,
 * `/connections`).
 *
 * All listeners registered for one stream share a single underlying socket, so
 * the controller is not hammered with N connections for N renderer subscribers.
 * On an unexpected drop the transport reconnects with exponential backoff plus
 * jitter, and it never replays buffered messages, so a reconnect cannot produce
 * duplicate events. An unsubscribe removes only that listener, and when the last
 * listener goes away the socket and any pending reconnect are torn down cleanly.
 */

export type MihomoStreamValue = unknown

/** The subset of the `ws` client surface the transport needs; injectable for tests. */
export interface MihomoSocket {
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown
  removeAllListeners?(event?: 'open' | 'message' | 'close' | 'error'): void
  close(): void
  terminate(): void
  readonly readyState: number
}

export const SOCKET_OPEN = 1
export const SOCKET_CLOSED = 3

export type MihomoSocketFactory = (url: string, secret: string | null) => MihomoSocket

/** A typed WebSocket client message. `data` is a Buffer or string; decoded below. */
type RawMessage = import('ws').RawData

export interface MihomoStreamOptions {
  /** Maximum reconnect attempts before giving up (0 = reconnect forever). */
  maxRetries?: number
  /** Base delay before the first reconnect, in milliseconds. */
  backoffMs?: number
  /** Upper bound on the reconnect delay, in milliseconds. */
  maxBackoffMs?: number
  /** Random jitter multiplier applied to each backoff, e.g. 0.2 = +/-20%. */
  jitter?: number
}

export interface MihomoStreamConfig<T> {
  /** Fully-qualified WebSocket URL, e.g. `ws://127.0.0.1:49210/traffic`. */
  url: string
  /** Bearer secret, when the controller enforces authorization. */
  secret?: string
  /** Parse and validate one raw JSON message into the stream value type. */
  parse: (raw: unknown) => T
  /** Invoked when a received message is not valid JSON or fails validation. */
  onParseError?: (error: unknown) => void
  /** Invoked when the transport cannot (re)connect to the controller. */
  onConnectionError?: (error: unknown) => void
  options?: MihomoStreamOptions
  socketFactory?: MihomoSocketFactory
}

export interface MihomoStream<T> {
  subscribe(listener: (value: T) => void): () => void
  close(): void
}

function defaultSocketFactory(url: string, secret: string | null): MihomoSocket {
  const socket = new WebSocket(url, secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined)
  return socket as unknown as MihomoSocket
}

export class MihomoStreamImpl<T> implements MihomoStream<T> {
  private readonly url: string
  private readonly secret: string | null
  private readonly parse: (raw: unknown) => T
  private readonly onParseError: ((error: unknown) => void) | undefined
  private readonly onConnectionError: ((error: unknown) => void) | undefined
  private readonly socketFactory: MihomoSocketFactory
  private readonly maxRetries: number
  private readonly backoffMs: number
  private readonly maxBackoffMs: number
  private readonly jitter: number

  private readonly listeners = new Set<(value: T) => void>()
  private socket: MihomoSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private closed = false

  constructor(config: MihomoStreamConfig<T>) {
    this.url = config.url
    this.secret = config.secret ?? null
    this.parse = config.parse
    this.onParseError = config.onParseError
    this.onConnectionError = config.onConnectionError
    this.socketFactory = config.socketFactory ?? defaultSocketFactory
    this.maxRetries = config.options?.maxRetries ?? 8
    this.backoffMs = config.options?.backoffMs ?? 250
    this.maxBackoffMs = config.options?.maxBackoffMs ?? 5000
    this.jitter = config.options?.jitter ?? 0.2
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.closed = false
      this.attempt = 0
      this.connect()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.close()
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      this.socket.removeAllListeners?.()
      this.socket.terminate()
      this.socket = null
    }
    this.listeners.clear()
    this.attempt = 0
  }

  private connect(): void {
    if (this.closed || this.socket) return
    let socket: MihomoSocket
    try {
      socket = this.socketFactory(this.url, this.secret)
    } catch (error) {
      this.onConnectionError?.(error)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.on('message', (data) => this.onMessage(data as RawMessage))
    socket.on('close', () => this.onClose())
    socket.on('error', (error) => this.onConnectionError?.(error))
    socket.on('open', () => {
      this.attempt = 0
    })
  }

  private onMessage(data: RawMessage): void {
    let raw: unknown
    try {
      raw = JSON.parse(data.toString())
    } catch (error) {
      this.onParseError?.(error)
      return
    }
    let value: T
    try {
      value = this.parse(raw)
    } catch (error) {
      this.onParseError?.(error)
      return
    }
    for (const listener of Array.from(this.listeners)) listener(value)
  }

  private onClose(): void {
    this.socket = null
    if (this.closed) return
    if (this.listeners.size === 0) return
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = this.backoffDelay(this.attempt)
    if (this.maxRetries > 0 && this.attempt >= this.maxRetries) {
      this.onConnectionError?.(new Error('reconnect attempts exhausted'))
      return
    }
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** Exponential backoff with jitter, clamped to the configured maximum. */
  backoffDelay(attempt: number): number {
    const base = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** attempt)
    const jitterFactor = this.jitter <= 0 ? 1 : 1 + (Math.random() * 2 - 1) * this.jitter
    return Math.round(base * jitterFactor)
  }
}

export function createMihomoStream<T>(config: MihomoStreamConfig<T>): MihomoStream<T> {
  return new MihomoStreamImpl(config)
}
