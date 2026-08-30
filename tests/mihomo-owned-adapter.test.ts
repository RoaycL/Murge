import { describe, expect, it, vi } from 'vitest'
import { MihomoOwnedTunAdapter } from '../src/main/tun/mihomo-owned-adapter'
import { TunServiceClient, type TunServiceTransport } from '../src/main/tun/service-client'
import { TUN_SERVICE_PROTOCOL_VERSION, type TunServiceRequest } from '../src/main/tun/service-protocol'

function serviceResponse(request: TunServiceRequest, outcome: 'running' | 'stopped') {
  return {
    protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
    requestId: request.requestId,
    outcome,
    sessionId: outcome === 'running' && request.operation === 'start' ? request.sessionId : null,
    pid: outcome === 'running' ? 5151 : null,
    errorCode: null
  }
}

function setup(readiness = vi.fn(async () => undefined)) {
  const transport: TunServiceTransport = {
    request: vi.fn(async request => serviceResponse(request, request.operation === 'stop' ? 'stopped' : 'running'))
  }
  const client = new TunServiceClient(transport)
  const adapter = new MihomoOwnedTunAdapter(
    client,
    () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ef'.repeat(32) }),
    { waitUntilReady: readiness },
    100
  )
  return { adapter, client, transport, readiness }
}

describe('mihomo-owned TUN lifecycle adapter', () => {
  it('starts strict profile and becomes active only after authenticated readiness', async () => {
    const { adapter, transport, readiness } = setup()
    await expect(adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })).resolves.toEqual({ outcome: 'active' })
    expect(readiness).toHaveBeenCalledWith(expect.objectContaining({ controllerPort: 19090, secret: 'ef'.repeat(32), signal: expect.any(AbortSignal) }))
    const start = vi.mocked(transport.request).mock.calls[0][0]
    expect(start.operation).toBe('start')
    if (start.operation === 'start') expect(start.profile).toContain('strict-route: false')
  })

  it('stops the exact child when readiness fails', async () => {
    const { adapter, client, transport } = setup(vi.fn(async () => { throw new Error('controller timeout') }))
    await expect(adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })).resolves.toEqual({ outcome: 'rollback-required', errorMessage: 'controller timeout' })
    expect(client.getOwnedSession()).toBeNull()
    expect(vi.mocked(transport.request).mock.calls.map(call => call[0].operation)).toEqual(['start', 'stop'])
  })

  it('does not claim restoration when service stop is unconfirmed', async () => {
    const { adapter, transport } = setup()
    await adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })
    vi.mocked(transport.request).mockImplementationOnce(async request => ({
      ...serviceResponse(request, 'stopped'),
      outcome: 'stopping', sessionId: '8a86eb80-621f-4a73-8249-1e4455df80de', pid: 5151, errorCode: 'STOP_TIMEOUT'
    }))
    await expect(adapter.restore()).resolves.toMatchObject({ outcome: 'restore-failed' })
  })
})
