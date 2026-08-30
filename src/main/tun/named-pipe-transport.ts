import { createConnection, type Socket } from 'node:net'
import type { TunServiceRequest } from './service-protocol'
import type { TunServiceTransport } from './service-client'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

const MAX_RESPONSE_BYTES = 8 * 1024

export type TunPipeConnector = (path: string) => Socket

export class NamedPipeTunServiceTransport implements TunServiceTransport {
  private readonly path: string

  constructor(pipeName: string, private readonly timeoutMs = 10_000, private readonly connect: TunPipeConnector = createConnection) {
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(pipeName)) invalid('unsafe TUN service pipe name')
    this.path = `\\\\.\\pipe\\${pipeName}`
  }

  request(message: TunServiceRequest, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.connect(this.path)
      let settled = false
      let buffered = Buffer.alloc(0)
      const finish = (error?: unknown, value?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        socket.removeAllListeners()
        socket.destroy()
        error === undefined ? resolve(value) : reject(error)
      }
      const onAbort = (): void => finish(new ProtocolError(ProtocolErrorCode.UPSTREAM_TIMEOUT, 'TUN service request was cancelled'))
      const timer = setTimeout(() => finish(new ProtocolError(ProtocolErrorCode.UPSTREAM_TIMEOUT, 'TUN service request timed out')), this.timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      socket.once('connect', () => {
        const frame = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
        socket.write(frame)
      })
      socket.on('data', (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        if (buffered.length > MAX_RESPONSE_BYTES) {
          finish(new ProtocolError(ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID, 'TUN service response exceeded the byte limit'))
          return
        }
        const newline = buffered.indexOf(0x0a)
        if (newline === -1) return
        if (buffered.subarray(newline + 1).some(byte => byte !== 0x0d && byte !== 0x0a)) {
          finish(new ProtocolError(ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID, 'TUN service returned multiple frames'))
          return
        }
        try {
          finish(undefined, JSON.parse(buffered.subarray(0, newline).toString('utf8')))
        } catch {
          finish(new ProtocolError(ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID, 'TUN service returned invalid JSON'))
        }
      })
      socket.once('error', () => finish(new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'TUN service is unavailable')))
      socket.once('end', () => finish(new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'TUN service closed without a response')))
    })
  }
}

function invalid(message: string): never {
  throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, message)
}
