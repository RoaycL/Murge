import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { LiveSystemProxyKernelProbe, probeHttp, probeSocks } from '../src/main/system-proxy/probe'
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

/** Listen a net server on an ephemeral loopback port and return it. */
function listenPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, SYSTEM_PROXY_LOOPBACK_HOST, () => {
      const address = server.address() as { port: number }
      resolve(address.port)
    })
  })
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

describe('probeHttp timeout / target safety (P2-1, P2-2)', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers) server.close()
    servers.length = 0
  })

  function listen(handler: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer(handler)
      server.listen(0, SYSTEM_PROXY_LOOPBACK_HOST, () => {
        const address = server.address() as { port: number }
        resolve({ server, port: address.port })
      })
    })
  }

  it('times out on a split status line that never completes (P2-1)', async () => {
    // The proxy answers only the first fragment `HTT`, then holds the connection
    // open with NO further data. The OLD probe cleared its total timer on that
    // first chunk, leaving the promise pending forever; the fix keeps the timer.
    const { server, port } = await listen((socket) => {
      socket.on('data', () => {
        socket.write('HTT')
        // intentionally: no close, no more data
      })
    })
    servers.push(server)
    await expect(probeHttp(port, 250)).rejects.toThrow(/timed out/)
  })

  it('accepts a proxy 5xx status line (502 Bad Gateway) as proof of HTTP proxying', async () => {
    const { server, port } = await listen((socket) => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      })
    })
    servers.push(server)
    await expect(probeHttp(port, 400)).resolves.toBeUndefined()
  })

  it('sends its CONNECT to the explicit loopback literal, never a public host (P2-2)', async () => {
    let connectTarget = ''
    const { server, port } = await listen((socket) => {
      socket.on('data', (chunk) => {
        const text = chunk.toString('latin1')
        const m = /^CONNECT (\S+)/.exec(text)
        if (m) connectTarget = m[1]
        if (/^CONNECT .* HTTP/.test(text)) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      })
    })
    servers.push(server)
    await expect(probeHttp(port, 400)).resolves.toBeUndefined()
    expect(connectTarget).toBe('127.0.0.1:1')
  })

  it('settles exactly once when a proxy answers then immediately closes', async () => {
    const { server, port } = await listen((socket) => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\n\r\n')
        socket.end()
      })
    })
    servers.push(server)
    // Must not reject with a spurious "closed without a status line" after the
    // status line already satisfied the probe (the `finish` guard).
    await expect(probeHttp(port, 400)).resolves.toBeUndefined()
  })
})

describe('probeSocks', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers) server.close()
    servers.length = 0
  })

  it('accepts the SOCKS5 no-auth greeting reply', async () => {
    const server = createServer((socket: Socket) => {
      socket.on('data', () => socket.write(Buffer.from([0x05, 0x00])))
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, SYSTEM_PROXY_LOOPBACK_HOST, () => {
        const address = server.address() as { port: number }
        resolve(address.port)
      })
    })
    servers.push(server)
    await expect(probeSocks(port, 400)).resolves.toBeUndefined()
  })

  it('rejects when the greeting reply is not a SOCKS5 no-auth method', async () => {
    const server = createServer((socket: Socket) => {
      socket.on('data', () => socket.write(Buffer.from([0x05, 0xff])))
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, SYSTEM_PROXY_LOOPBACK_HOST, () => {
        const address = server.address() as { port: number }
        resolve(address.port)
      })
    })
    servers.push(server)
    await expect(probeSocks(port, 400)).rejects.toThrow(/unexpected SOCKS5 greeting reply/)
  })

  it('accepts the `05 00` reply split across two TCP chunks (P2-1)', async () => {
    // A real mixed-port may deliver the 2-byte greeting as two separate segments.
    // The OLD probe read only the first chunk (a lone `05`) and rejected it as an
    // unexpected reply; the fix accumulates until at least 2 bytes arrive.
    const server = createServer((socket: Socket) => {
      socket.on('error', () => {})
      socket.on('data', () => {
        socket.write(Buffer.from([0x05]))
        setTimeout(() => {
          if (socket.writable) socket.write(Buffer.from([0x00]))
        }, 25)
      })
    })
    const port = await listenPort(server)
    servers.push(server)
    await expect(probeSocks(port, 1000)).resolves.toBeUndefined()
  })

  it('fails at the TOTAL timeout when the reply is an incomplete `05` and the connection stays open (P2-1)', async () => {
    // The proxy answers only the first byte then holds the connection open with no
    // further data and no close. The probe must wait out the whole exchange timer
    // (it must NOT reject instantly on a partial chunk, which would misjudge a
    // slow-but-real mixed-port).
    const server = createServer((socket: Socket) => {
      socket.on('data', () => socket.write(Buffer.from([0x05])))
    })
    const port = await listenPort(server)
    servers.push(server)
    await expect(probeSocks(port, 250)).rejects.toThrow(/timed out/)
  })

  it('settles exactly once when the proxy answers `05 00` then immediately closes', async () => {
    const server = createServer((socket: Socket) => {
      socket.on('data', () => {
        socket.write(Buffer.from([0x05, 0x00]))
        socket.end()
      })
    })
    const port = await listenPort(server)
    servers.push(server)
    // Must not double-reject with a spurious "closed without a greeting reply"
    // after the reply already satisfied the probe (the `finish` guard).
    await expect(probeSocks(port, 400)).resolves.toBeUndefined()
  })
})
