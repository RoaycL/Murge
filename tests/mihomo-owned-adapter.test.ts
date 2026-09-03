import { describe, expect, it, vi } from 'vitest'
import { MihomoOwnedTunAdapter } from '../src/main/tun/mihomo-owned-adapter'
import { TunServiceClient, type TunServiceTransport } from '../src/main/tun/service-client'
import { TUN_SERVICE_PROTOCOL_VERSION, type TunServiceRequest } from '../src/main/tun/service-protocol'

function serviceResponse(request: TunServiceRequest, outcome: 'running' | 'stopped') {
  return {
    protocolVersion: TUN_SERVICE_PROTOCOL_VERSION,
    requestId: request.requestId,
    outcome,
    sessionId: outcome === 'running'
      ? (request.operation === 'start' ? request.sessionId : '8a86eb80-621f-4a73-8249-1e4455df80de')
      : null,
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

const PROXY_DOCUMENT = [
  'mixed-port: 7890',
  'mode: rule',
  'proxies:',
  '  - name: node-a',
  '    type: ss',
  '    server: example.invalid',
  '    port: 8388',
  '    cipher: aes-128-gcm',
  '    password: pw',
  'proxy-groups:',
  '  - name: PROXY',
  '    type: select',
  '    proxies:',
  '      - node-a',
  '      - DIRECT',
  'rules:',
  '  - MATCH,PROXY',
  ''
].join('\n')

/** Adapter wired with an active-profile source, as production does. */
function setupProxied(readActiveDocument: () => Promise<string | null>) {
  const transport: TunServiceTransport = {
    request: vi.fn(async request => serviceResponse(request, request.operation === 'stop' ? 'stopped' : 'running'))
  }
  const client = new TunServiceClient(transport)
  const adapter = new MihomoOwnedTunAdapter(
    client,
    () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ef'.repeat(32) }),
    { waitUntilReady: vi.fn(async () => undefined) },
    100,
    undefined,
    { readActiveDocument }
  )
  const submittedProfile = (): string => {
    const start = vi.mocked(transport.request).mock.calls[0][0]
    if (start.operation !== 'start') throw new Error('first request was not a start')
    return start.profile
  }
  return { adapter, client, transport, submittedProfile }
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
    vi.mocked(transport.request).mockImplementationOnce(async request => serviceResponse(request, 'running'))
      .mockImplementationOnce(async request => ({
        ...serviceResponse(request, 'stopped'),
        outcome: 'stopping', sessionId: '8a86eb80-621f-4a73-8249-1e4455df80de', pid: 5151, errorCode: 'STOP_TIMEOUT'
      }))
    await expect(adapter.restore()).resolves.toMatchObject({ outcome: 'restore-failed' })
  })

  it('reconciles and stops a service-owned child after the desktop client restarts', async () => {
    const { adapter, client, transport } = setup()
    expect(client.getOwnedSession()).toBeNull()

    await expect(adapter.restore()).resolves.toEqual({ outcome: 'restored' })

    expect(client.getOwnedSession()).toBeNull()
    expect(vi.mocked(transport.request).mock.calls.map(call => call[0].operation)).toEqual(['reconcile', 'stop'])
  })

  it('folds the persisted config model into the started profile', async () => {
    const transport: TunServiceTransport = {
      request: vi.fn(async request => serviceResponse(request, request.operation === 'stop' ? 'stopped' : 'running'))
    }
    const client = new TunServiceClient(transport)
    const adapter = new MihomoOwnedTunAdapter(
      client,
      () => ({ mixedPort: 17890, controllerPort: 19090, secret: 'ef'.repeat(32) }),
      { waitUntilReady: vi.fn(async () => undefined) },
      100,
      async () => ({ stack: 'system', device: 'TUN-0', mtu: 1500, strictRoute: true, autoRoute: false, autoDetectInterface: true, dnsHijack: ['any:53'], routeAddress: ['192.168.0.0/16'], routeExcludeAddress: [] })
    )
    await expect(adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })).resolves.toEqual({ outcome: 'active' })
    const start = vi.mocked(transport.request).mock.calls[0][0]
    if (start.operation === 'start') {
      expect(start.profile).toContain('  stack: system')
      expect(start.profile).toContain('  device: TUN-0')
      expect(start.profile).toContain('  mtu: 1500')
      expect(start.profile).toContain('  strict-route: true')
      expect(start.profile).toContain('  auto-route: false')
    }
  })
})

describe('mihomo-owned TUN adapter — proxied profile', () => {
  it('submits the active profile proxies and rules so TUN actually proxies', async () => {
    const { adapter, submittedProfile } = setupProxied(async () => PROXY_DOCUMENT)
    await expect(adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })).resolves.toEqual({ outcome: 'active' })
    const profile = submittedProfile()
    expect(profile).toContain('node-a')
    expect(profile).toContain('MATCH,PROXY')
    expect(profile).toMatch(/mode:\s*rule/)
    // The DIRECT-only bootstrap must NOT be what reaches the service.
    expect(profile).not.toContain('MATCH,DIRECT')
    // TUN still owns the adapter and the controller stays loopback-authenticated.
    expect(profile).toMatch(/enable:\s*true/)
    expect(profile).toContain('127.0.0.1:19090')
  })

  it('falls back to the DIRECT bootstrap when no profile is active', async () => {
    const { adapter, submittedProfile } = setupProxied(async () => null)
    await expect(adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })).resolves.toEqual({ outcome: 'active' })
    const profile = submittedProfile()
    // A rule-mode config with no proxies would reference absent groups, so the
    // conservative bootstrap is the only safe thing to start here.
    expect(profile).toContain('MATCH,DIRECT')
    expect(profile).toContain('mode: direct')
    expect(profile).not.toContain('node-a')
  })

  it('exposes the owned session port only while TUN is active', async () => {
    const { adapter } = setupProxied(async () => PROXY_DOCUMENT)
    expect(adapter.getActiveRuntime()).toBeNull()
    await adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })
    // The system proxy needs this port to coexist with TUN (the main kernel is
    // stopped in that state, so its own port is dead).
    expect(adapter.getActiveRuntime()).toEqual({ mixedPort: 17890, controllerPort: 19090, secret: 'ef'.repeat(32) })
    await adapter.restore()
    expect(adapter.getActiveRuntime()).toBeNull()
  })

  it('does not leak the runtime handle to callers', async () => {
    const { adapter } = setupProxied(async () => PROXY_DOCUMENT)
    await adapter.enable({ schemaVersion: 2, device: 'Product TUN', stack: 'mixed' })
    const first = adapter.getActiveRuntime()!
    first.mixedPort = 1
    expect(adapter.getActiveRuntime()!.mixedPort).toBe(17890)
  })
})
