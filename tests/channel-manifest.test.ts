import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM script without type declarations
import { electronInstallerName, selectElectronInstallers } from '../scripts/channel-manifest.mjs'
import { installerProduct } from '../src/main/updates/signed-manifest-driver'
import { verifyMinisign } from '../src/main/updates/minisign'

const run = promisify(execFile)

/** A throwaway minisign keypair in Tauri's base64-wrapped format. */
function makeKey(): { publicKey: string; signFile: (data: Buffer, trustedComment: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')
  const keyId = randomBytes(8)
  const pub = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`
  return {
    publicKey: Buffer.from(pub).toString('base64'),
    signFile: (data, trustedComment) => {
      const fileSignature = sign(null, createHash('blake2b512').update(data).digest(), privateKey)
      const globalSignature = sign(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), privateKey)
      return Buffer.from([
        'untrusted comment: signature from tauri secret key',
        Buffer.concat([Buffer.from('ED'), keyId, fileSignature]).toString('base64'),
        `trusted comment: ${trustedComment}`,
        globalSignature.toString('base64'),
        ''
      ].join('\n')).toString('base64')
    }
  }
}

describe('channel-manifest', () => {
  it('names installers the way electron-builder does and the updater recognises', () => {
    const name = electronInstallerName('App', '1.2.3', 'x64')
    expect(name).toBe('App-Setup-1.2.3-x64.exe')
    expect(installerProduct(name)).toBe('electron')
    expect(() => selectElectronInstallers([name], 'App', '1.2.3')).toThrow(/missing installer App-Setup-1.2.3-arm64.exe/)
    expect(() => electronInstallerName('My App', '1.2.3', 'x64')).toThrow(/not usable by the updater/)
  })

  it('writes a manifest the Electron driver accepts, with the release notes', async () => {
    const brand = JSON.parse(await readFile('brand.config.json', 'utf8')) as { productName: string; repositoryUrl: string }
    const key = makeKey()
    const dir = await mkdtemp(join(tmpdir(), 'channel-manifest-'))
    try {
      for (const arch of ['x64', 'arm64']) {
        const fileName = electronInstallerName(brand.productName, '1.2.3', arch)
        const data = Buffer.from(`installer ${arch}`)
        await writeFile(join(dir, fileName), data)
        await writeFile(join(dir, `${fileName}.sig`), key.signFile(data, `timestamp:1\tfile:${fileName}\tversion:1.2.3`))
      }
      await writeFile(join(dir, 'notes.md'), '- 修复了一些问题\n')
      const out = join(dir, 'channel', 'latest.json')
      await run(process.execPath, ['scripts/channel-manifest.mjs', '--version', '1.2.3', '--tag', 'v1.2.3', '--dir', dir,
        '--notes-file', join(dir, 'notes.md'), '--out', out, '--pubkey', key.publicKey])
      const manifest = JSON.parse(await readFile(out, 'utf8')) as {
        version: string
        notes: string
        platforms: Record<string, { url: string; signature: string }>
      }
      expect(manifest.version).toBe('1.2.3')
      expect(manifest.notes).toBe('- 修复了一些问题\n')
      const x64 = manifest.platforms['windows-x86_64']!
      expect(x64.url).toBe(`${brand.repositoryUrl}/releases/download/v1.2.3/${electronInstallerName(brand.productName, '1.2.3', 'x64')}`)
      const fileName = electronInstallerName(brand.productName, '1.2.3', 'x64')
      expect(verifyMinisign(await readFile(join(dir, fileName)), x64.signature, key.publicKey)).toMatchObject({ version: '1.2.3', file: fileName })
      expect(manifest.platforms['windows-aarch64']).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a signature that is not bound to the release version', async () => {
    const brand = JSON.parse(await readFile('brand.config.json', 'utf8')) as { productName: string }
    const key = makeKey()
    const dir = await mkdtemp(join(tmpdir(), 'channel-manifest-'))
    try {
      for (const arch of ['x64', 'arm64']) {
        const fileName = electronInstallerName(brand.productName, '1.2.3', arch)
        const data = Buffer.from(`installer ${arch}`)
        await writeFile(join(dir, fileName), data)
        await writeFile(join(dir, `${fileName}.sig`), key.signFile(data, `timestamp:1\tfile:${fileName}`))
      }
      await expect(run(process.execPath, ['scripts/channel-manifest.mjs', '--version', '1.2.3', '--tag', 'v1.2.3', '--dir', dir,
        '--out', join(dir, 'latest.json'), '--pubkey', key.publicKey])).rejects.toThrow(/sign with --app-version/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
