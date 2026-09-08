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
      () => ({ mixedPort: 17890, httpPort: 17891, socksPort: 17892, controllerPort: 19090, secret: 'ab'.repeat(32) }),
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
    if (start?.operation === 'start') {
      expect(start.profile).toContain('enable: false')
      expect(start.profile).toContain('port: 17891')
      expect(start.profile).toContain('socks-port: 17892')
    }
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

  it('fails immediately with the service diagnostic when the owned core exits before readiness', async () => {
    let running = false
    const transport: TunServiceTransport = {
      request: vi.fn(async request => {
        if (request.operation === 'start') {
          running = true
          return response(request, 'running')
        }
        if (request.operation === 'reconcile' && running) {
          running = false
          return {
            protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
            requestId: request.requestId,
            outcome: 'failed',
            sessionId: null,
            pid: null,
            errorCode: 'TUN_SERVICE_OPERATION_FAILED',
            validationMessage: 'mihomo rejected the generated configuration'
          }
        }
        return response(request, 'stopped')
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
      { waitUntilReady: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) },
      'Product TUN',
      5_000
    )

    await expect(gateway.start()).rejects.toMatchObject({
      code: ProtocolErrorCode.KERNEL_SPAWN_FAILED,
      message: 'mihomo rejected the generated configuration'
    })
    expect(gateway.getStatus()).toMatchObject({ phase: 'failed', lastError: 'mihomo rejected the generated configuration' })
  })

  it('preserves a port reclaim failure instead of misreporting it as a controller timeout', async () => {
    const gateway = new PrivilegedServiceKernelGateway(
      new TunServiceClient({ request: async request => response(request, 'stopped') }),
      () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ab'.repeat(32) }),
      {
        readActiveDocument: async () => null,
        readTunConfig: async () => ({ ...EMPTY_TUN_CONFIG }),
        readCore: async () => ({ ...EMPTY_CORE_SETTINGS }),
        readGeodata: async () => ({ ...EMPTY_GEODATA_SETTINGS })
      },
      { waitUntilReady: async () => undefined },
      'Product TUN',
      100,
      () => true,
      () => { throw new ProtocolError(ProtocolErrorCode.KERNEL_RUNNING, '端口仍被占用') }
    )

    await expect(gateway.start()).rejects.toMatchObject({
      code: ProtocolErrorCode.KERNEL_RUNNING,
      message: '端口仍被占用'
    })
  })

  it('passes the selected version to the service and verifies the controller result', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => response(request, request.operation === 'start' ? 'running' : 'stopped'))
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
      { waitUntilReady: async () => ({ version: '1.19.29' }) },
      'Product TUN',
      10_000,
      () => true,
      () => undefined,
      async () => ({ channel: 'specific', specificVersion: 'v1.19.29' })
    )
    await expect(gateway.start()).resolves.toMatchObject({ phase: 'running', version: '1.19.29' })
    const start = vi.mocked(transport.request).mock.calls.map(call => call[0]).find(request => request.operation === 'start')
    expect(start).toMatchObject({ operation: 'start', version: 'v1.19.29' })
  })

  it('builds the profile before reclaiming ports and starts immediately afterwards', async () => {
    const events: string[] = []
    const transport: TunServiceTransport = {
      request: vi.fn(async request => {
        if (request.operation === 'start') events.push('start')
        return response(request, request.operation === 'start' ? 'running' : 'stopped')
      })
    }
    const gateway = new PrivilegedServiceKernelGateway(
      new TunServiceClient(transport),
      () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ab'.repeat(32) }),
      {
        readActiveDocument: async () => { events.push('build'); return null },
        readTunConfig: async () => ({ ...EMPTY_TUN_CONFIG }),
        readCore: async () => ({ ...EMPTY_CORE_SETTINGS }),
        readGeodata: async () => ({ ...EMPTY_GEODATA_SETTINGS })
      },
      { waitUntilReady: async () => undefined },
      'Product TUN',
      10_000,
      () => true,
      () => { events.push('reclaim') }
    )

    await gateway.start()

    expect(events).toEqual(['build', 'reclaim', 'start'])
  })
})
