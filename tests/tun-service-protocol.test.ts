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
      protocolVersion: 2,
      requestId: '1',
      operation: 'start',
      sessionId: '8a86eb80-621f-4a73-8249-1e4455df80de',
      profile,
      profileSha256: createHash('sha256').update(profile).digest('hex')
    }).operation).toBe('start')
  })

  it('rejects digest mismatch, unsafe config and arbitrary command fields', () => {
    const base = {
      protocolVersion: 2,
      requestId: '1',
      operation: 'start',
      sessionId: '8a86eb80-621f-4a73-8249-1e4455df80de',
      profile,
      profileSha256: createHash('sha256').update(profile).digest('hex')
    }
    expect(() => parseTunServiceRequest({ ...base, profileSha256: '0'.repeat(64) })).toThrow()
    const unsafe = profile.replace('allow-lan: false', 'allow-lan: true')
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
    await expect(client.start(profile)).rejects.toThrow(/already owned/)
    await client.stop()
    expect(client.getOwnedSession()).toBeNull()
    const calls = vi.mocked(transport.request).mock.calls.map(call => call[0])
    expect(calls[1]).toMatchObject({ operation: 'stop', sessionId: owned.sessionId })
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
        protocolVersion: 2,
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
