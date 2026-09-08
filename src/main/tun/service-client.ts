import { createHash, randomUUID } from 'node:crypto'
import { parseTunServiceResponse, TUN_SERVICE_PROTOCOL_VERSION, type TunServiceRequest, type TunServiceResponse } from './service-protocol'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { ProfileProviderContent } from '../../shared/profiles'

export interface TunServiceTransport {
  request(message: TunServiceRequest, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>
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

  async start(profile: string, signal?: AbortSignal, version?: string): Promise<TunOwnedSession> {
    if (this.ownedSession) fail(ProtocolErrorCode.KERNEL_RUNNING, 'A TUN session is already owned')
    const requestId = this.takeRequestId()
    const sessionId = randomUUID()
    const response = await this.exchange({
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId,
      operation: 'start',
      sessionId,
      profile,
      profileSha256: createHash('sha256').update(profile, 'utf8').digest('hex'),
      ...(version ? { version } : {})
    }, signal)
    if (response.outcome === 'conflict') {
      fail(ProtocolErrorCode.TUN_SERVICE_CONFLICT, response.errorCode ?? 'TUN service ownership conflict')
    }
    if (response.outcome !== 'running' || response.sessionId !== sessionId || response.pid === null) {
      fail(ProtocolErrorCode.KERNEL_SPAWN_FAILED, response.errorCode ?? `Service returned ${response.outcome}`)
    }
    this.ownedSession = { sessionId, pid: response.pid }
    return { ...this.ownedSession }
  }

  /** Ask the privileged service to fetch and verify one official mihomo release. */
  async installVersion(version: string, proxyPort?: number, signal?: AbortSignal): Promise<void> {
    const response = await this.exchange({
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId: this.takeRequestId(),
      operation: 'install',
      version,
      ...(proxyPort ? { proxyPort } : {})
    }, signal, 150_000)
    if (response.outcome !== 'installed') {
      fail(ProtocolErrorCode.ARTIFACT_DOWNLOAD_FAILED, response.errorCode ?? `Service returned ${response.outcome}`)
    }
  }

  /** Validate with the same pinned binary the LocalSystem service will run. */
  async validateProfile(profile: string, version?: string, signal?: AbortSignal): Promise<void> {
    const response = await this.exchange({
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId: this.takeRequestId(),
      operation: 'validate',
      profile,
      profileSha256: createHash('sha256').update(profile, 'utf8').digest('hex'),
      ...(version ? { version } : {})
    }, signal, 45_000)
    if (response.outcome !== 'valid') {
      fail(ProtocolErrorCode.INVALID_ARGUMENT, response.validationMessage || response.errorCode || `Service returned ${response.outcome}`)
    }
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
    if (response.outcome === 'conflict') {
      fail(ProtocolErrorCode.TUN_SERVICE_CONFLICT, response.errorCode ?? 'TUN service ownership conflict')
    }
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
    if (response.outcome === 'conflict') {
      fail(ProtocolErrorCode.TUN_SERVICE_CONFLICT, response.errorCode ?? 'TUN service ownership conflict')
    }
    if (response.outcome === 'running' && response.sessionId && response.pid) {
      this.ownedSession = { sessionId: response.sessionId, pid: response.pid }
    } else if (response.outcome === 'stopped') {
      this.ownedSession = null
    }
    return response
  }

  /** Read one provider from the service-owned live mihomo home. */
  async getProviderContent(kind: 'proxy' | 'rule', name: string, signal?: AbortSignal): Promise<ProfileProviderContent> {
    const response = await this.exchange({
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId: this.takeRequestId(),
      operation: 'provider-content',
      providerKind: kind,
      providerName: name
    }, signal, 30_000)
    if (response.outcome !== 'content' || response.content === undefined || response.contentFormat === undefined || response.contentSource === undefined) {
      const messages: Record<string, string> = {
        PROVIDER_NOT_FOUND: '当前运行配置中没有这个外部资源',
        PROVIDER_CACHE_MISSING: '资源缓存尚未生成，请先更新资源',
        PROVIDER_PATH_UNAVAILABLE: '该资源没有可读取的缓存路径',
        PROVIDER_CONTENT_TOO_LARGE: '资源内容超过 4 MiB，暂时无法预览',
        PROVIDER_CONTENT_INVALID: '资源缓存不是可显示的文本内容',
        PROVIDER_MRS_CONVERT_FAILED: 'MRS 规则集转换失败'
      }
      fail(ProtocolErrorCode.INTERNAL, messages[response.errorCode ?? ''] ?? response.errorCode ?? `Service returned ${response.outcome}`)
    }
    return { kind, name, content: response.content, format: response.contentFormat, source: response.contentSource }
  }

  private takeRequestId(): string {
    if (this.nextRequestId === 0xffffffffffffffffn) fail(ProtocolErrorCode.TUN_HELPER_PROTOCOL_INVALID, 'requestId exhausted')
    this.nextRequestId += 1n
    return this.nextRequestId.toString(10)
  }

  private async exchange(request: TunServiceRequest, signal?: AbortSignal, timeoutMs?: number): Promise<TunServiceResponse> {
    const raw = await this.transport.request(request, signal, timeoutMs)
    return parseTunServiceResponse(raw, request.requestId)
  }
}

function fail(code: ProtocolErrorCode, message: string): never {
  throw new ProtocolError(code, message)
}
