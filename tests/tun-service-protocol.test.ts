import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { generateMihomoTunConfig } from '../src/main/tun/mihomo-tun-config'
import { parseTunServiceRequest, TUN_SERVICE_PROTOCOL_VERSION, type TunServiceRequest } from '../src/main/tun/service-protocol'
import { TunServiceClient, type TunServiceTransport } from '../src/main/tun/service-client'

const profile = generateMihomoTunConfig({
  mixedPort: 17890,
  controllerPort: 19090,
  secret: 'cd'.repeat(32),
  device: 'Product TUN'
})

function response(request: TunServiceRequest, outcome: 'running' | 'stopped' = 'running') {
  return {
    protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
    requestId: request.requestId,
    outcome,
    sessionId: outcome === 'running' && request.operation === 'start' ? request.sessionId : null,
    pid: outcome === 'running' ? 4242 : null,
    errorCode: null
  }
}

describe('Phase 9B privileged service protocol', () => {
  it('accepts an exact digest-bound strict profile', () => {
    expect(parseTunServiceRequest({
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId: '1',
      operation: 'start',
      sessionId: '8a86eb80-621f-4a73-8249-1e4455df80de',
      profile,
      profileSha256: createHash('sha256').update(profile).digest('hex')
    }).operation).toBe('start')
  })

  it('rejects digest mismatch, unsafe config and arbitrary command fields', () => {
    const base = {
      protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
      requestId: '1',
      operation: 'start',
      sessionId: '8a86eb80-621f-4a73-8249-1e4455df80de',
      profile,
      profileSha256: createHash('sha256').update(profile).digest('hex')
    }
    expect(() => parseTunServiceRequest({ ...base, profileSha256: '0'.repeat(64) })).toThrow()
    const unsafe = profile.replace('allow-lan: false', 'allow-lan: invalid')
    expect(() => parseTunServiceRequest({ ...base, profile: unsafe, profileSha256: createHash('sha256').update(unsafe).digest('hex') })).toThrow()
    expect(() => parseTunServiceRequest({ ...base, executable: 'cmd.exe' })).toThrow()
  })

  it('starts and stops only the exact owned session', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => response(request, request.operation === 'stop' ? 'stopped' : 'running'))
    }
    const client = new TunServiceClient(transport)
    const owned = await client.start(profile)
    expect(owned).toEqual({ sessionId: expect.any(String), pid: 4242 })
    expect(vi.mocked(transport.request)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ operation: 'start' }),
      undefined,
      150_000
    )
    await expect(client.start(profile)).rejects.toThrow(/already owned/)
    await client.stop()
    expect(client.getOwnedSession()).toBeNull()
    const calls = vi.mocked(transport.request).mock.calls.map(call => call[0])
    expect(calls[1]).toMatchObject({ operation: 'stop', sessionId: owned.sessionId })
  })

  it('requests an official version install with the extended timeout', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => ({
        protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
        requestId: request.requestId,
        outcome: 'installed',
        sessionId: null,
        pid: null,
        errorCode: null
      }))
    }
    await expect(new TunServiceClient(transport).installVersion('v1.19.29', 7890)).resolves.toBeUndefined()
    expect(vi.mocked(transport.request)).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'install', version: 'v1.19.29', proxyPort: 7890 }),
      undefined,
      150_000
    )
    await expect(new TunServiceClient(transport).installVersion('smart')).resolves.toBeUndefined()
    expect(vi.mocked(transport.request)).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'install', version: 'smart' }),
      undefined,
      150_000
    )
  })

  it('validates the exact digest-bound profile with the service-owned kernel', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => ({
        protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
        requestId: request.requestId,
        outcome: 'valid',
        sessionId: null,
        pid: null,
        errorCode: null
      }))
    }
    await expect(new TunServiceClient(transport).validateProfile(profile, 'v1.19.30')).resolves.toBeUndefined()
    expect(vi.mocked(transport.request)).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'validate', version: 'v1.19.30', profile }),
      undefined,
      45_000
    )
  })

  it('surfaces mihomo validation output without starting or replacing the owned session', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => ({
        protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
        requestId: request.requestId,
        outcome: 'failed',
        sessionId: null,
        pid: null,
        errorCode: 'CONFIG_INVALID',
        validationMessage: 'mihomo config validation failed: invalid proxy type'
      }))
    }
    const client = new TunServiceClient(transport)
    await expect(client.validateProfile(profile)).rejects.toThrow(/invalid proxy type/)
    expect(client.getOwnedSession()).toBeNull()
  })

  it('reads a named provider without exposing a file path', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => ({
        protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
        requestId: request.requestId,
        outcome: 'content',
        sessionId: null,
        pid: null,
        errorCode: null,
        content: 'payload:\n  - example.com\n',
        contentFormat: 'yaml',
        contentSource: 'cache'
      }))
    }
    await expect(new TunServiceClient(transport).getProviderContent('rule', 'Ads')).resolves.toEqual({
      kind: 'rule', name: 'Ads', content: 'payload:\n  - example.com\n', format: 'yaml', source: 'cache'
    })
    expect(vi.mocked(transport.request)).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'provider-content', providerKind: 'rule', providerName: 'Ads' }),
      undefined,
      30_000
    )
    expect(vi.mocked(transport.request).mock.calls[0]?.[0]).not.toHaveProperty('path')
  })

  it('retains ownership when stop is not confirmed', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => request.operation === 'stop'
        ? { ...response(request, 'stopped'), outcome: 'stopping', sessionId: request.sessionId, pid: 4242, errorCode: 'STOP_TIMEOUT' }
        : response(request))
    }
    const client = new TunServiceClient(transport)
    await client.start(profile)
    await expect(client.stop()).rejects.toThrow(/STOP_TIMEOUT/)
    expect(client.getOwnedSession()?.pid).toBe(4242)
  })

  it('rejects response replay/mismatched request IDs', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => ({ ...response(request), requestId: '999' }))
    }
    await expect(new TunServiceClient(transport).start(profile)).rejects.toThrow(/Invalid TUN service protocol message/)
  })

  it('maps a service ownership conflict to a typed protocol error', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => ({
        protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
        requestId: request.requestId,
        outcome: 'conflict',
        sessionId: null,
        pid: null,
        errorCode: 'PROCESS_IDENTITY_MISMATCH'
      }))
    }
    await expect(new TunServiceClient(transport).start(profile)).rejects.toMatchObject({
      code: 'TUN_SERVICE_CONFLICT'
    })
  })
})
