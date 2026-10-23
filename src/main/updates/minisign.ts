import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * Minisign verification for Tauri updater signatures (the format
 * `tauri signer sign` writes): base64-wrapped minisign documents, Ed25519,
 * usually over a BLAKE2b-512 prehash. The global signature covers the
 * trusted comment, so its `version:` / `file:` fields are authenticated.
 */

function unwrap(base64Text: string, what: string): string[] {
  const text = Buffer.from(base64Text.trim(), 'base64').toString('utf8')
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2 || !lines[0]!.startsWith('untrusted comment:')) {
    throw new Error(`${what} is not a base64-encoded minisign document`)
  }
  return lines
}

function parsePublicKey(base64Text: string): { keyId: Buffer; key: Buffer } {
  const raw = Buffer.from(unwrap(base64Text, 'public key')[1]!, 'base64')
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('public key is not an Ed25519 minisign key')
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) }
}

/**
 * Verify `data` against a Tauri signature and the pinned public key. Returns
 * the trusted comment's `key:value` fields; throws on any mismatch.
 */
export function verifyMinisign(data: Uint8Array, signatureBase64: string, publicKeyBase64: string): Record<string, string> {
  const publicKey = parsePublicKey(publicKeyBase64)
  const lines = unwrap(signatureBase64, 'signature')
  const raw = Buffer.from(lines[1]!, 'base64')
  const algorithm = raw.subarray(0, 2).toString('latin1')
  if (raw.length !== 74 || (algorithm !== 'Ed' && algorithm !== 'ED')) {
    throw new Error('signature is not an Ed25519 minisign signature')
  }
  if (!raw.subarray(2, 10).equals(publicKey.keyId)) {
    throw new Error('signature was made with a different key than the pinned public key')
  }
  const trustedLine = lines[2] ?? ''
  if (!trustedLine.startsWith('trusted comment: ')) throw new Error('signature has no trusted comment')
  const trustedComment = trustedLine.slice('trusted comment: '.length)
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64')
  if (globalSignature.length !== 64) throw new Error('signature has no global signature')

  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey.key.toString('base64url') }, format: 'jwk' })
  const fileSignature = raw.subarray(10)
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : Buffer.from(data)
  if (!verify(null, message, key, fileSignature)) throw new Error('file signature does not verify')
  const signedComment = Buffer.concat([fileSignature, Buffer.from(trustedComment, 'utf8')])
  if (!verify(null, signedComment, key, globalSignature)) throw new Error('trusted comment signature does not verify')

  return Object.fromEntries(
    trustedComment.split('\t').map((field) => {
      const index = field.indexOf(':')
      return index === -1 ? [field, ''] : [field.slice(0, index), field.slice(index + 1)]
    })
  )
}
