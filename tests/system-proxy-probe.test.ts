import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { LiveSystemProxyKernelProbe } from '../src/main/system-proxy/probe'
import type { KernelGateway } from '../src/shared/gateways'
import type { MihomoConfigSnapshot } from '../src/shared/mihomo-api'
/**
 * LiveSystemProxyKernelProbe must PROVE the mixed-port is a live kernel listener
 * (TCP + HTTP CONNECT + SOCKS5) before it will hand back a target for the system
 * proxy to point at. These tests run on any platform (pure node:net, no registry)
 * and never touch a real kernel: they drive the probe against an in-process
 * minimal http+socks socket server standing in for mihomo's mixed-port.
 */

const runningStatus = { phase: 'running' as const }

function fakeKernel(phase: 'running' | 'stopped'): KernelGateway {
  const status = () => ({ phase }) as never
  return {
    getStatus: async () => status(),
    start: async () => status(),
    stop: async () => status(),
    onStatus: () => () => {}
  } as unknown as KernelGateway
}

function fakeMihomo(config: MihomoConfigSnapshot): {
  getVersion: () => Promise<unknown>
  getConfig: () => Promise<MihomoConfigSnapshot>
} {
  return {
    getVersion: async () => ({ version: '1.0.0' }),
    getConfig: async () => config
  }
}

/** Answer the SOCKS5 no-auth greeting and accept an HTTP CONNECT (like a mixed-port). */
function startMixedServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length >= 2 && buffer[0] === 0x05) {
          socket.write(Buffer.from([0x05, 0x00]))
          return
        }
        const text = buffer.toString('latin1')
        if (/^CONNECT .* HTTP\/\d\.\d/.test(text)) {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        }
      })
    })
    server.listen(0, SYSTEM_PROXY_LOOPBACK_HOST, () => {
      const address = server.address() as { port: number }
      resolve({ server, port: address.port })
    })
  })
}

describe('LiveSystemProxyKernelProbe', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers) server.close()
    servers.length = 0
  })

  it('resolves the live mixed-port after passing the HTTP + SOCKS probes', async () => {
    const { server, port } = await startMixedServer()
    servers.push(server)
    const probe = new LiveSystemProxyKernelProbe(
      fakeKernel('running'),
      fakeMihomo({ 'mixed-port': port } as MihomoConfigSnapshot)
    )
    const target = await probe.resolveTarget()
    expect(target).toEqual({ host: SYSTEM_PROXY_LOOPBACK_HOST, port })
  })

  it('refuses when the kernel is not running', async () => {
    const probe = new LiveSystemProxyKernelProbe(
      fakeKernel('stopped'),
      fakeMihomo({ 'mixed-port': 7890 } as MihomoConfigSnapshot)
    )
    await expect(probe.resolveTarget()).rejects.toMatchObject({
      code: ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED
    })
  })

  it('refuses when the controller is not ready (getVersion throws)', async () => {
    const probe = new LiveSystemProxyKernelProbe(
      fakeKernel('running'),
      {
        getVersion: async () => {
          throw new Error('controller down')
        },
        getConfig: async () => ({ 'mixed-port': 7890 }) as MihomoConfigSnapshot
      }
    )
    await expect(probe.resolveTarget()).rejects.toMatchObject({
      code: ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED
    })
  })

  it('refuses when the mixed-port is not a live listener', async () => {
    // Nothing is listening on this reserved port, so the socket probe fails.
    const probe = new LiveSystemProxyKernelProbe(
      fakeKernel('running'),
      fakeMihomo({ 'mixed-port': 1 } as MihomoConfigSnapshot)
    )
    await expect(probe.resolveTarget()).rejects.toMatchObject({
      code: ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED
    })
  })

  it('refuses a non-integer / out-of-range mixed-port', async () => {
    for (const bad of [undefined, 0, -1, 1.5, 70000]) {
      const probe = new LiveSystemProxyKernelProbe(
        fakeKernel('running'),
        fakeMihomo({ 'mixed-port': bad } as MihomoConfigSnapshot)
      )
      await expect(probe.resolveTarget()).rejects.toMatchObject({
        code: ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED
      })
    }
  })
})
