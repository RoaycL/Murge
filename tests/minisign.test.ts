import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// Electron's BoringSSL has no BLAKE2: reproduce that, so the prehash cannot
// silently fall back on Node's OpenSSL in these tests.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    createHash: (algorithm: string, ...rest: unknown[]) => {
      if (/blake2/i.test(algorithm)) throw new Error('Digest method not supported')
      return (actual.createHash as (...args: unknown[]) => ReturnType<typeof actual.createHash>)(algorithm, ...rest)
    }
  }
})

const { createPrehash, verifyMinisign } = await import('../src/main/updates/minisign')

describe('verifyMinisign', () => {
  it('verifies a prehashed (ED) signature without Node BLAKE2', async () => {
    const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
    expect(() => createHash('blake2b512')).toThrow('Digest method not supported')
    const data = randomBytes(300_000)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')
    const keyId = randomBytes(8)
    const pub = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`).toString('base64')
    const comment = 'timestamp:1\tfile:App_1.0.0_x64-setup.exe\tversion:1.0.0'
    const fileSignature = sign(null, actual.createHash('blake2b512').update(data).digest(), privateKey)
    const globalSignature = sign(null, Buffer.concat([fileSignature, Buffer.from(comment)]), privateKey)
    const signature = Buffer.from([
      'untrusted comment: signature from tauri secret key',
      Buffer.concat([Buffer.from('ED'), keyId, fileSignature]).toString('base64'),
      `trusted comment: ${comment}`,
      globalSignature.toString('base64'),
      ''
    ].join('\n')).toString('base64')

    expect(verifyMinisign(data, signature, pub)).toMatchObject({ file: 'App_1.0.0_x64-setup.exe', version: '1.0.0' })

    // The streamed prehash gives the same answer, chunk boundaries aside.
    const prehash = createPrehash()
    for (let offset = 0; offset < data.length; offset += 65_536) prehash.update(data.subarray(offset, offset + 65_536))
    expect(verifyMinisign(data, signature, pub, prehash.digest())).toMatchObject({ version: '1.0.0' })
    expect(() => verifyMinisign(data, signature, pub, new Uint8Array(64))).toThrow('file signature does not verify')
  })
})
