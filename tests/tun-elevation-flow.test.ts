import { describe, expect, it, vi } from 'vitest'
import {
  GatedTunElevationActivator,
  TunElevationFlow,
  type PrivilegedHelperSession,
  type TunElevationActivator,
  type TunIntegrityGate
} from '../src/main/tun/elevation-flow'
import type { TunBinaryManifestEntry } from '../src/main/tun/binary-integrity'
import { ProtocolErrorCode } from '../src/shared/protocol-errors'

const manifest: TunBinaryManifestEntry[] = [
  { role: 'helper', canonicalPath: 'C:\\Program Files\\Product\\tun-helper.exe', sha256: 'a'.repeat(64), publisherThumbprint: 'b'.repeat(40) },
  { role: 'wintun-dll', canonicalPath: 'C:\\Program Files\\Product\\wintun.dll', sha256: 'c'.repeat(64), publisherThumbprint: null }
]

function integrity(failure?: unknown): TunIntegrityGate {
  return {
    verifyAll: vi.fn(async () => {
      if (failure) throw failure
      return []
    })
  }
}

function session(): PrivilegedHelperSession & { alive: boolean } {
  const value = {
    alive: true,
    close: vi.fn(async () => { value.alive = false }),
    isAlive: vi.fn(async () => value.alive)
  }
  return value
}

function activator(owned = session()): TunElevationActivator {
  return { activate: vi.fn(async () => ({ outcome: 'connected' as const, session: owned })) }
}

describe('TunElevationFlow non-executable orchestration', () => {
  it('verifies integrity before prompting and owns one live session', async () => {
    const events: string[] = []
    const gate = integrity()
    const activation = activator()
    const flow = new TunElevationFlow(gate, activation, manifest, true)
    flow.onStatus(status => events.push(status.phase))

    await flow.connect()
    expect(events).toEqual(['verifying', 'prompting', 'connected'])
    expect(gate.verifyAll).toHaveBeenCalledWith(manifest)
    expect(activation.activate).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent connect intents into one activation', async () => {
    const activation = activator()
    const flow = new TunElevationFlow(integrity(), activation, manifest, true)
    await Promise.all([flow.connect(), flow.connect(), flow.connect()])
    expect(activation.activate).toHaveBeenCalledTimes(1)
    expect(flow.getStatus().phase).toBe('connected')
  })

  it('never prompts when integrity verification fails', async () => {
    const gate = integrity(new Error('digest mismatch'))
    const activation = activator()
    const flow = new TunElevationFlow(gate, activation, manifest, true)
    await flow.connect()
    expect(flow.getStatus()).toEqual({ phase: 'failed', errorCode: 'TUN_ELEVATION_FAILED' })
    expect(activation.activate).not.toHaveBeenCalled()
  })

  it('surfaces a user-denied UAC prompt without a session', async () => {
    const activation: TunElevationActivator = { activate: vi.fn(async () => ({ outcome: 'denied' })) }
    const flow = new TunElevationFlow(integrity(), activation, manifest, true)
    await flow.connect()
    expect(flow.getStatus()).toEqual({ phase: 'denied', errorCode: 'TUN_ELEVATION_DENIED' })
    await flow.disconnect()
    expect(flow.getStatus().phase).toBe('idle')
  })

  it('confirms helper exit before releasing session ownership', async () => {
    const owned = session()
    const flow = new TunElevationFlow(integrity(), activator(owned), manifest, true)
    await flow.connect()
    await flow.disconnect()
    expect(owned.close).toHaveBeenCalledTimes(1)
    expect(owned.isAlive).toHaveBeenCalledTimes(2)
    expect(flow.getStatus().phase).toBe('idle')
  })

  it('retains a still-live helper so disconnect can be retried', async () => {
    const owned = session()
    owned.close = vi.fn(async () => undefined)
    const flow = new TunElevationFlow(integrity(), activator(owned), manifest, true)
    await flow.connect()
    await flow.disconnect()
    expect(flow.getStatus()).toEqual({ phase: 'failed', errorCode: 'TUN_HELPER_STILL_ALIVE' })
    owned.close = vi.fn(async () => { owned.alive = false })
    await flow.disconnect()
    expect(flow.getStatus().phase).toBe('idle')
  })

  it('keeps unsupported platforms inert', async () => {
    const gate = integrity()
    const activation = activator()
    const flow = new TunElevationFlow(gate, activation, manifest, false)
    await flow.connect()
    await flow.disconnect()
    expect(flow.getStatus().phase).toBe('unsupported')
    expect(gate.verifyAll).not.toHaveBeenCalled()
    expect(activation.activate).not.toHaveBeenCalled()
  })

  it('keeps the production activator fail-closed', async () => {
    await expect(new GatedTunElevationActivator().activate()).rejects.toMatchObject({
      code: ProtocolErrorCode.TUN_IMPLEMENTATION_GATED
    })
  })

  it('does not let a renderer listener interrupt connect or teardown', async () => {
    const flow = new TunElevationFlow(integrity(), activator(), manifest, true)
    flow.onStatus(() => { throw new Error('renderer gone') })
    await flow.connect()
    await flow.disconnect()
    expect(flow.getStatus().phase).toBe('idle')
  })
})
