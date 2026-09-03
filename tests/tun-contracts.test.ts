import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TunAuditLog } from '../src/main/tun/audit-log'
import {
  buildComSecurityDescriptorContract,
  COM_ACCESS_MASK,
  COM_LAUNCH_MASK,
  STATE_DIRECTORY_SDDL
} from '../src/main/tun/security-descriptors'
import { initialTunStatus, transitionTunStatus } from '../src/main/tun/state-machine'
import { desiredNetworkStateSchema, tunStatusSchema } from '../src/shared/schemas/tun'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'
import { TUN_IPC } from '../src/shared/tun'

describe('Phase 9 non-network contracts', () => {
  it('reserves stable IPC names without registering an activation path', () => {
    expect(TUN_IPC).toEqual({
      getStatus: 'tun:get-status',
      enable: 'tun:enable',
      disable: 'tun:disable',
      statusEvent: 'tun:status-event'
    })
    const preload = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const handlers = readFileSync(resolve(process.cwd(), 'src/main/ipc/handlers.ts'), 'utf8')
    expect(preload).not.toContain('TUN_IPC')
    expect(handlers).not.toContain('TUN_IPC')
  })

  it('validates the reviewed DesiredNetworkState canonical types', () => {
    const parsed = desiredNetworkStateSchema.parse({
      schemaVersion: 1,
      adapter: { name: 'Product TUN', tunnelType: 'Product TUN', requestedGuid: '65f5cc87-e5db-4e9a-a5a4-8dcf7049ea4d' },
      routes: [{ family: 4, destination: '0.0.0.0', prefixLength: 0, nextHop: null, metric: 10, routeStore: 'active' }],
      dns: [{ luid: '0xaf', servers: ['1.1.1.1'], source: 'static' }],
      metrics: [{ luid: '0xaf', metric: 5 }]
    })
    expect(parsed.schemaVersion).toBe(1)
  })

  it('rejects unsafe numeric LUIDs and mismatched IP families', () => {
    const base = {
      schemaVersion: 1,
      adapter: { name: 'Product TUN', tunnelType: 'Product TUN', requestedGuid: '65f5cc87-e5db-4e9a-a5a4-8dcf7049ea4d' },
      routes: [{ family: 4, destination: '::', prefixLength: 0, nextHop: null, metric: 10, routeStore: 'active' }],
      dns: [{ luid: 42, servers: ['1.1.1.1'], source: 'static' }],
      metrics: []
    }
    expect(desiredNetworkStateSchema.safeParse(base).success).toBe(false)
    expect(desiredNetworkStateSchema.safeParse({
      ...base,
      routes: [],
      dns: [{ luid: '0x000a', servers: ['1.1.1.1'], source: 'static' }]
    }).success).toBe(false)
  })

  it('rejects ambiguous duplicate and multi-adapter network intents', () => {
    const base = {
      schemaVersion: 1,
      adapter: { name: 'Product TUN', tunnelType: 'Product TUN', requestedGuid: '65f5cc87-e5db-4e9a-a5a4-8dcf7049ea4d' },
      routes: [{ family: 4 as const, destination: '0.0.0.0', prefixLength: 0, nextHop: null, metric: 10, routeStore: 'active' as const }],
      dns: [{ luid: '0xaf', servers: ['1.1.1.1'], source: 'static' as const }],
      metrics: [{ luid: '0xaf', metric: 5 }]
    }
    expect(desiredNetworkStateSchema.safeParse({ ...base, routes: [...base.routes, ...base.routes] }).success).toBe(false)
    expect(desiredNetworkStateSchema.safeParse({
      ...base,
      dns: [{ ...base.dns[0], servers: ['1.1.1.1', '1.1.1.1'] }]
    }).success).toBe(false)
    expect(desiredNetworkStateSchema.safeParse({ ...base, dns: [...base.dns, ...base.dns] }).success).toBe(false)
    expect(desiredNetworkStateSchema.safeParse({ ...base, metrics: [...base.metrics, ...base.metrics] }).success).toBe(false)
    expect(desiredNetworkStateSchema.safeParse({
      ...base,
      metrics: [{ luid: '0xbe', metric: 5 }]
    }).success).toBe(false)
  })

  it('rejects adapter labels containing control characters', () => {
    const value = {
      schemaVersion: 1,
      adapter: { name: 'Product\nTUN', tunnelType: 'Product TUN', requestedGuid: '65f5cc87-e5db-4e9a-a5a4-8dcf7049ea4d' },
      routes: [],
      dns: [],
      metrics: []
    }
    expect(desiredNetworkStateSchema.safeParse(value).success).toBe(false)
  })

  it('enforces supported/unsupported and conflict status invariants', () => {
    expect(tunStatusSchema.safeParse(initialTunStatus(false)).success).toBe(true)
    expect(tunStatusSchema.safeParse({ ...initialTunStatus(true), phase: 'conflict' }).success).toBe(false)
  })

  it('executes only reviewed lifecycle transitions', () => {
    const configured = initialTunStatus(true)
    const starting = transitionTunStatus(configured, 'enable', {}, new Date('2026-01-01T00:00:00Z'))
    const active = transitionTunStatus(starting, 'enabled')
    const restoring = transitionTunStatus(active, 'disable')
    const restored = transitionTunStatus(restoring, 'restored')
    expect([starting.phase, active.phase, restoring.phase, restored.phase]).toEqual(['starting', 'active', 'restoring', 'configured'])
    expect(() => transitionTunStatus(configured, 'enabled')).toThrowError(ProtocolError)
  })

  it('requires conflict evidence and preserves typed errors', () => {
    expect(() => transitionTunStatus(initialTunStatus(true), 'conflict')).toThrowError()
    try {
      transitionTunStatus(initialTunStatus(true), 'enabled')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.TUN_INVALID_TRANSITION)
    }
  })

  it('builds the exact pure allow-list COM and state-directory SDDL contracts', () => {
    const ownerSid = 'S-1-5-21-111-222-333-1001'
    const contract = buildComSecurityDescriptorContract(ownerSid)
    expect(contract).toEqual({
      launchSddl: `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;${ownerSid})`,
      accessSddl: `D:P(A;;0x3;;;SY)(A;;0x3;;;${ownerSid})`,
      launchMask: COM_LAUNCH_MASK,
      accessMask: COM_ACCESS_MASK
    })
    expect(STATE_DIRECTORY_SDDL).toBe('O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)S:(ML;OICI;NW;;;HI)')
    expect(contract.launchSddl).not.toMatch(/\(D;/)
    expect(contract.accessSddl).not.toContain(';;;BA)')
    expect(() => buildComSecurityDescriptorContract('not-a-sid')).toThrowError(ProtocolError)
  })

  it('keeps the Go service state-directory SDDL byte-for-byte in sync with the TS contract', () => {
    // Cross-language contract: the Windows service hardens the SAME directory,
    // so its embedded SDDL string must never drift from STATE_DIRECTORY_SDDL
    // (this pairing was the source of a reviewed ML-label drift).
    const go = readFileSync(resolve(process.cwd(), 'native/tun-service/runtime_windows.go'), 'utf8')
    expect(go).toContain(`const stateDirectorySDDL = "${STATE_DIRECTORY_SDDL}"`)
  })

  it('rotates the audit log by entry and byte limits without exposing mutable entries', () => {
    const log = new TunAuditLog(10_000, 2)
    log.append('enable-intent', 'configured', null, new Date('2026-01-01T00:00:00Z'))
    log.append('transition', 'starting')
    log.append('transition', 'active')
    expect(log.length).toBe(2)
    const snapshot = log.snapshot()
    snapshot[0].phase = 'tampered'
    expect(log.snapshot()[0].phase).toBe('starting')
    expect(() => log.append('failure', 'failed', 'secret=value with spaces')).toThrowError(TypeError)
  })

  it('keeps the foundation source free of process, network, Wintun and elevation calls', () => {
    const files = ['audit-log.ts', 'binary-integrity.ts', 'coordinator.ts', 'elevation-flow.ts', 'helper-protocol.ts', 'security-descriptors.ts', 'state-machine.ts']
    const forbidden = /child_process|execFile|spawn\s*\(|fetch\s*\(|WebSocket|Wintun(?:Create|Open|Close)|CoGetObject|netsh|SetIpForwardEntry|SetInterfaceDnsSettings/
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), 'src/main/tun', file), 'utf8')
      expect(source, file).not.toMatch(forbidden)
    }
  })
})
