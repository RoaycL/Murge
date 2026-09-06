import { describe, expect, it, vi } from 'vitest'
import { PrivilegedServiceKernelGateway } from '../src/main/kernel/privileged-service-gateway'
import { TunServiceClient, type TunServiceTransport } from '../src/main/tun/service-client'
import { TUN_SERVICE_PROTOCOL_VERSION, type TunServiceRequest } from '../src/main/tun/service-protocol'
import { EMPTY_CORE_SETTINGS } from '../src/shared/core-settings'
import { EMPTY_GEODATA_SETTINGS } from '../src/shared/geodata'
import { EMPTY_TUN_CONFIG } from '../src/shared/tun-config'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'

function response(request: TunServiceRequest, outcome: 'running' | 'stopped') {
  return {
    protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
    requestId: request.requestId,
    outcome,
    sessionId: outcome === 'running' ? (request.operation === 'start' ? request.sessionId : '8a86eb80-621f-4a73-8249-1e4455df80de') : null,
    pid: outcome === 'running' ? 4242 : null,
    errorCode: null
  }
}

describe('privileged persistent kernel gateway', () => {
  it('starts one service core with TUN dormant and stops the same owned session', async () => {
    let running = false
    const transport: TunServiceTransport = {
      request: vi.fn(async request => {
        if (request.operation === 'start') running = true
        if (request.operation === 'stop') running = false
        return response(request, running ? 'running' : 'stopped')
      })
    }
    const gateway = new PrivilegedServiceKernelGateway(
      new TunServiceClient(transport),
      () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ab'.repeat(32) }),
      {
        readActiveDocument: async () => null,
        readTunConfig: async () => ({ ...EMPTY_TUN_CONFIG }),
        readCore: async () => ({ ...EMPTY_CORE_SETTINGS }),
        readGeodata: async () => ({ ...EMPTY_GEODATA_SETTINGS })
      },
      { waitUntilReady: vi.fn(async () => ({ version: '1.19.30' })) },
      'Product TUN'
    )
    await gateway.initialize()
    await expect(gateway.start()).resolves.toMatchObject({ phase: 'running', pid: 4242, version: '1.19.30' })
    const start = vi.mocked(transport.request).mock.calls.map(call => call[0]).find(request => request.operation === 'start')
    expect(start?.operation).toBe('start')
    if (start?.operation === 'start') expect(start.profile).toContain('enable: false')
    await expect(gateway.stop()).resolves.toMatchObject({ phase: 'stopped', pid: null })
  })

  it('adopts a child when the start reply is lost instead of spawning twice', async () => {
    let running = false
    let startCalls = 0
    const transport: TunServiceTransport = {
      request: vi.fn(async request => {
        if (request.operation === 'start') {
          startCalls += 1
          running = true
          throw new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'reply lost')
        }
        return response(request, running ? 'running' : 'stopped')
      })
    }
    const gateway = new PrivilegedServiceKernelGateway(
      new TunServiceClient(transport),
      () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ab'.repeat(32) }),
      {
        readActiveDocument: async () => null,
        readTunConfig: async () => ({ ...EMPTY_TUN_CONFIG }),
        readCore: async () => ({ ...EMPTY_CORE_SETTINGS }),
        readGeodata: async () => ({ ...EMPTY_GEODATA_SETTINGS })
      },
      { waitUntilReady: vi.fn(async () => undefined) },
      'Product TUN',
      100
    )
    await expect(gateway.start()).resolves.toMatchObject({ phase: 'running', pid: 4242 })
    expect(startCalls).toBe(1)
  })
})
