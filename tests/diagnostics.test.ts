import { describe, expect, it } from 'vitest'
import { brand } from '@shared/brand'
import { serializeDiagnosticBundle } from '../src/renderer/src/lib/diagnostics'

describe('diagnostic bundle', () => {
  it('exports only allowlisted state and excludes secrets, paths and raw errors', () => {
    const text = serializeDiagnosticBundle({
      brand,
      app: { version: '1.2.3', platform: 'win32', arch: 'x64' },
      kernel: { phase: 'failed', pid: 7, version: null, controllerUrl: 'http://127.0.0.1:9090?secret=TOPSECRET', startedAt: null, lastError: 'C:\\Users\\Alice\\secret.yaml' },
      systemProxy: { supported: true, phase: 'enabled', address: '127.0.0.1', port: 7890, errorMessage: 'password=hunter2', conflictDetail: null, updatedAt: '' },
      startup: { supported: true, enabled: false, phase: 'idle', errorMessage: null },
      tun: { supported: true, phase: 'configured', errorMessage: 'token=bad', conflictDetail: null, updatedAt: null },
      kernelVersion: '1.19.30'
    }, new Date('2026-01-01T00:00:00.000Z'))
    expect(JSON.parse(text)).toMatchObject({ product: { version: '1.2.3' }, kernel: { phase: 'failed', version: '1.19.30' } })
    for (const forbidden of ['TOPSECRET', 'Alice', 'hunter2', 'token=bad', 'controllerUrl', 'lastError', '"address"', '"port"']) expect(text).not.toContain(forbidden)
  })
})
