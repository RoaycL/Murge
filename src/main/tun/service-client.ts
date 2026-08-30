import { createHash, randomUUID } from 'node:crypto'
import { parseTunServiceResponse, TUN_SERVICE_PROTOCOL_VERSION, type TunServiceRequest, type TunServiceResponse } from './service-protocol'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

export interface TunServiceTransport {
  request(message: TunServiceRequest, signal?: AbortSignal): Promise<unknown>
}

export interface TunOwnedSession {
  sessionId: string
  pid: number
}

/**
 * Typed ordinary-main to privileged-service client. It cannot choose a binary,
 * command line, working directory or environment. The service owns all of them.
 */
export class TunServiceClient {
  private nextRequestId = 0n
  private ownedSession: TunOwnedSession | null = null

  constructor(private readonly transport: TunServiceTransport) {}

  getOwnedSession(): TunOwnedSession | null {
    return this.ownedSession ? { ...this.ownedSession } : null
  }

  async start(profile: string, signal?: AbortSignal): Promise<TunOwnedSession> {
    if (this.ownedSession) fail(ProtocolErrorCode.KERNEL_RUNNING, 'A TUN session is already owned')
    const requestId = this.takeRequestId()
    const sessionId = randomUUID()
    const response = await this.exchange({
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId,
      operation: 'start',
      sessionId,
      profile,
      profileSha256: createHash('sha256').update(profile, 'utf8').digest('hex')
    }, signal)
    if (response.outcome !== 'running' || response.sessionId !== sessionId || response.pid === null) {
      fail(ProtocolErrorCode.KERNEL_SPAWN_FAILED, response.errorCode ?? `Service returned ${response.outcome}`)
    }
    this.ownedSession = { sessionId, pid: response.pid }
    return { ...this.ownedSession }
  }

  async stop(signal?: AbortSignal): Promise<void> {
    if (!this.ownedSession) return
    const owned = this.ownedSession
    const response = await this.exchange({
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId: this.takeRequestId(),
      operation: 'stop',
      sessionId: owned.sessionId
    }, signal)
    if (response.outcome !== 'stopped') {
      fail(ProtocolErrorCode.KERNEL_STOP_TIMEOUT, response.errorCode ?? `Service returned ${response.outcome}`)
    }
    this.ownedSession = null
  }

  async reconcile(signal?: AbortSignal): Promise<TunServiceResponse> {
    const response = await this.exchange({
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId: this.takeRequestId(),
      operation: 'reconcile'
    }, signal)
    if (response.outcome === 'running' && response.sessionId && response.pid) {
      this.ownedSession = { sessionId: response.sessionId, pid: response.pid }
    } else if (response.outcome === 'stopped') {
      this.ownedSession = null
    }
    return response
  }

  private takeRequestId(): string {
    if (this.nextRequestId === 0xffffffffffffffffn) fail(ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID, 'requestId exhausted')
    this.nextRequestId += 1n
    return this.nextRequestId.toString(10)
  }

  private async exchange(request: TunServiceRequest, signal?: AbortSignal): Promise<TunServiceResponse> {
    const raw = await this.transport.request(request, signal)
    return parseTunServiceResponse(raw, request.requestId)
  }
}

function fail(code: ProtocolErrorCode, message: string): never {
  throw new ProtocolError(code, message)
}
