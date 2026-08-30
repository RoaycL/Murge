import { describe, expect, it, vi } from 'vitest'
import {
  GatedTunBinaryInspector,
  TunBinaryIntegrityVerifier,
  verifyObservation,
  type TunBinaryInspector,
  type TunBinaryManifestEntry,
  type TunBinaryObservation
} from '../src/main/tun/binary-integrity'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'

const helper: TunBinaryManifestEntry = {
  role: 'helper',
  canonicalPath: 'C:\\Program Files\\Product\\tun-helper.exe',
  sha256: 'a'.repeat(64),
  publisherThumbprint: 'b'.repeat(40)
}

const wintun: TunBinaryManifestEntry = {
  role: 'wintun-dll',
  canonicalPath: 'C:\\Program Files\\Product\\wintun.dll',
  sha256: 'c'.repeat(64),
  publisherThumbprint: null
}

function observation(entry: TunBinaryManifestEntry): TunBinaryObservation {
  return {
    canonicalPath: entry.canonicalPath,
    sha256: entry.sha256,
    authenticodeStatus: entry.role === 'helper' ? 'valid' : 'unsigned',
    publisherThumbprint: entry.publisherThumbprint
  }
}

function inspector(overrides: Partial<Record<TunBinaryManifestEntry['role'], Partial<TunBinaryObservation>>> = {}): TunBinaryInspector {
  return {
    inspect: vi.fn(async path => {
      const entry = path.toLowerCase().endsWith('wintun.dll') ? wintun : helper
      return { ...observation(entry), ...overrides[entry.role] }
    })
  }
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run()
    throw new Error('expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(code)
  }
}

describe('TUN binary integrity policy (read-only)', () => {
  it('requires both entries and verifies helper signature plus both digests', async () => {
    const source = inspector()
    const evidence = await new TunBinaryIntegrityVerifier(source).verifyAll([helper, wintun])
    expect(evidence).toEqual([
      { role: 'helper', canonicalPath: helper.canonicalPath, sha256: helper.sha256, signatureChecked: true, verified: true },
      { role: 'wintun-dll', canonicalPath: wintun.canonicalPath, sha256: wintun.sha256, signatureChecked: false, verified: true }
    ])
    expect(source.inspect).toHaveBeenCalledTimes(2)
  })

  it('validates the entire manifest before touching a file', async () => {
    const source = inspector()
    await expect(new TunBinaryIntegrityVerifier(source).verifyAll([helper, { ...wintun, sha256: 'bad' }])).rejects.toMatchObject({
      code: ProtocolErrorCode.TUN_BINARY_INTEGRITY_FAILED
    })
    expect(source.inspect).not.toHaveBeenCalled()
  })

  it('fails closed when the release publisher decision is missing', async () => {
    const source = inspector()
    await expect(new TunBinaryIntegrityVerifier(source).verifyAll([
      { ...helper, publisherThumbprint: null },
      wintun
    ])).rejects.toMatchObject({ code: ProtocolErrorCode.TUN_IMPLEMENTATION_GATED })
    expect(source.inspect).not.toHaveBeenCalled()
  })

  it.each([
    ['digest mismatch', { sha256: 'd'.repeat(64) }],
    ['unsigned', { authenticodeStatus: 'unsigned' as const }],
    ['invalid signature', { authenticodeStatus: 'invalid' as const }],
    ['untrusted signature', { authenticodeStatus: 'untrusted' as const }],
    ['publisher mismatch', { publisherThumbprint: 'e'.repeat(40) }],
    ['path diversion', { canonicalPath: 'C:\\Users\\Public\\tun-helper.exe' }]
  ])('rejects helper %s', (_name, change) => {
    expectCode(
      () => verifyObservation(helper, { ...observation(helper), ...change }),
      ProtocolErrorCode.TUN_BINARY_INTEGRITY_FAILED
    )
  })

  it('compares canonical Windows paths case-insensitively but rejects relative paths', () => {
    expect(verifyObservation(helper, { ...observation(helper), canonicalPath: 'c:\\PROGRAM FILES\\PRODUCT\\tun-helper.exe' }).verified).toBe(true)
    expectCode(
      () => verifyObservation({ ...helper, canonicalPath: '..\\tun-helper.exe' }, observation(helper)),
      ProtocolErrorCode.TUN_BINARY_INTEGRITY_FAILED
    )
  })

  it('allows digest-only Wintun DLL policy but rejects a fake publisher pin', () => {
    expect(verifyObservation(wintun, observation(wintun)).signatureChecked).toBe(false)
    expectCode(
      () => verifyObservation({ ...wintun, publisherThumbprint: 'f'.repeat(40) }, observation(wintun)),
      ProtocolErrorCode.TUN_BINARY_INTEGRITY_FAILED
    )
  })

  it('keeps the production inspector gated', async () => {
    await expect(new GatedTunBinaryInspector().inspect(helper.canonicalPath)).rejects.toMatchObject({
      code: ProtocolErrorCode.TUN_IMPLEMENTATION_GATED
    })
  })
})
