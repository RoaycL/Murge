import { win32 } from 'node:path'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

const SHA256 = /^[0-9a-f]{64}$/
const THUMBPRINT = /^[0-9a-f]{40,128}$/

export type TunBinaryRole = 'helper' | 'wintun-dll'
export type AuthenticodeStatus = 'valid' | 'invalid' | 'unsigned' | 'untrusted' | 'error'

export interface TunBinaryManifestEntry {
  role: TunBinaryRole
  /** Installer-resolved absolute path, not a user-controlled path. */
  canonicalPath: string
  sha256: string
  /** Required for helper.exe; null is allowed only for digest-pinned wintun.dll. */
  publisherThumbprint: string | null
}

export interface TunBinaryObservation {
  canonicalPath: string
  sha256: string
  authenticodeStatus: AuthenticodeStatus
  publisherThumbprint: string | null
}

export interface TunBinaryInspector {
  inspect(path: string): Promise<TunBinaryObservation>
}

export interface TunBinaryIntegrityEvidence {
  role: TunBinaryRole
  canonicalPath: string
  sha256: string
  signatureChecked: boolean
  verified: true
}

/**
 * Production stays fail-closed until a reviewed native WinVerifyTrust inspector
 * and a release certificate thumbprint are supplied. No shell is spawned here.
 */
export class GatedTunBinaryInspector implements TunBinaryInspector {
  async inspect(_path: string): Promise<TunBinaryObservation> {
    throw new ProtocolError(
      ProtocolErrorCode.TUN_IMPLEMENTATION_GATED,
      'TUN binary inspection is gated pending the Windows helper implementation'
    )
  }
}

/** Read-only verification policy. It cannot load a DLL, elevate or mutate the OS. */
export class TunBinaryIntegrityVerifier {
  constructor(private readonly inspector: TunBinaryInspector) {}

  async verifyAll(entries: readonly TunBinaryManifestEntry[]): Promise<TunBinaryIntegrityEvidence[]> {
    if (entries.length !== 2 || new Set(entries.map(entry => entry.role)).size !== entries.length) {
      fail('manifest must contain exactly one helper and one wintun-dll entry')
    }
    // Validate the complete policy before inspecting either file.
    for (const entry of entries) validateManifestEntry(entry)

    const evidence: TunBinaryIntegrityEvidence[] = []
    for (const entry of entries) {
      const observed = await this.inspector.inspect(entry.canonicalPath)
      evidence.push(verifyObservation(entry, observed))
    }
    return evidence
  }
}

export function verifyObservation(
  expected: TunBinaryManifestEntry,
  observed: TunBinaryObservation
): TunBinaryIntegrityEvidence {
  validateManifestEntry(expected)
  if (!winPathEqual(expected.canonicalPath, observed.canonicalPath)) fail(`${expected.role}: canonical path mismatch`)
  if (!SHA256.test(observed.sha256) || observed.sha256 !== expected.sha256) fail(`${expected.role}: SHA-256 mismatch`)

  const signatureRequired = expected.role === 'helper'
  if (signatureRequired) {
    if (observed.authenticodeStatus !== 'valid') fail(`${expected.role}: Authenticode is not valid`)
    if (!observed.publisherThumbprint || observed.publisherThumbprint !== expected.publisherThumbprint) {
      fail(`${expected.role}: publisher thumbprint mismatch`)
    }
  }

  return {
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    sha256: expected.sha256,
    signatureChecked: signatureRequired,
    verified: true
  }
}

function validateManifestEntry(entry: TunBinaryManifestEntry): void {
  if (!win32.isAbsolute(entry.canonicalPath) || entry.canonicalPath.includes('\0')) {
    fail(`${entry.role}: canonical path must be an absolute Windows path`)
  }
  if (!SHA256.test(entry.sha256)) fail(`${entry.role}: invalid pinned SHA-256`)
  if (entry.role === 'helper' && (!entry.publisherThumbprint || !THUMBPRINT.test(entry.publisherThumbprint))) {
    throw new ProtocolError(
      ProtocolErrorCode.TUN_IMPLEMENTATION_GATED,
      'Helper publisher thumbprint is not configured'
    )
  }
  if (entry.role === 'wintun-dll' && entry.publisherThumbprint !== null) {
    fail('wintun-dll: publisher thumbprint must be null; the DLL is digest-pinned')
  }
}

function winPathEqual(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
}

function fail(reason: string): never {
  throw new ProtocolError(
    ProtocolErrorCode.TUN_BINARY_INTEGRITY_FAILED,
    'TUN binary integrity verification failed',
    { reason }
  )
}
