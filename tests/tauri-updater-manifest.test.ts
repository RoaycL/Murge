import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM script without type declarations
import { buildManifest, parseSignature, verifyMinisign } from '../scripts/tauri-updater-manifest.mjs'

/** A throwaway minisign keypair in Tauri's base64-wrapped format. */
function makeKey(): { publicKey: string; signFile: (data: Buffer, fields: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')
  const keyId = randomBytes(8)
  const pub = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`
  return {
    publicKey: Buffer.from(pub).toString('base64'),
    signFile: (data, trustedComment) => {
      const fileSignature = sign(null, createHash('blake2b512').update(data).digest(), privateKey)
      const globalSignature = sign(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), privateKey)
      const text = [
        'untrusted comment: signature from tauri secret key',
        Buffer.concat([Buffer.from('ED'), keyId, fileSignature]).toString('base64'),
        `trusted comment: ${trustedComment}`,
        globalSignature.toString('base64'),
        ''
      ].join('\n')
      return Buffer.from(text).toString('base64')
    }
  }
}

const data = Buffer.from('installer bytes')
const fileName = 'App_1.0.0_x64-setup.exe'

function manifestFor(signature: string, publicKey: string, installerData = data) {
  return buildManifest({
    version: '1.0.0',
    notes: 'notes',
    pubDate: '2026-10-21T00:00:00.000Z',
    repositoryUrl: 'https://github.com/owner/repo',
    publicKey,
    installers: { x64: { fileName, data: installerData, signature } }
  })
}

describe('tauri updater manifest', () => {
  it('writes the platform entry for a signature bound to the version and file', () => {
    const key = makeKey()
    const signature = key.signFile(data, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    expect(manifestFor(signature, key.publicKey)).toEqual({
      version: '1.0.0',
      notes: 'notes',
      pub_date: '2026-10-21T00:00:00.000Z',
      platforms: {
        'windows-x86_64': {
          signature,
          url: `https://github.com/owner/repo/releases/download/v1.0.0/${fileName}`
        }
      }
    })
  })

  it('rejects a signature without the signed version', () => {
    const key = makeKey()
    const signature = key.signFile(data, `timestamp:1\tfile:${fileName}`)
    expect(() => manifestFor(signature, key.publicKey)).toThrow(/--app-version/)
  })

  it('rejects a signature bound to another version or file', () => {
    const key = makeKey()
    expect(() => manifestFor(key.signFile(data, `timestamp:1\tfile:${fileName}\tversion:0.9.0`), key.publicKey)).toThrow(/0\.9\.0/)
    expect(() => manifestFor(key.signFile(data, 'timestamp:1\tfile:Other.exe\tversion:1.0.0'), key.publicKey)).toThrow(/Other\.exe/)
  })

  it('rejects tampered data, a forged trusted comment and a foreign key', () => {
    const key = makeKey()
    const signature = key.signFile(data, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    expect(() => manifestFor(signature, key.publicKey, Buffer.from('tampered'))).toThrow(/does not verify/)
    const forged = Buffer.from(
      Buffer.from(signature, 'base64').toString('utf8').replace('version:1.0.0', 'version:1.0.1')
    ).toString('base64')
    expect(() => verifyMinisign(data, forged, key.publicKey)).toThrow(/trusted comment/)
    expect(() => manifestFor(signature, makeKey().publicKey)).toThrow(/different key/)
  })

  it('refuses to build without a pinned public key', () => {
    const key = makeKey()
    const signature = key.signFile(data, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    expect(() => manifestFor(signature, '')).toThrow(/public key/)
    expect(parseSignature(signature).prehashed).toBe(true)
  })
})
