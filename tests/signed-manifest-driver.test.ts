import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SignedManifestUpdaterDriver,
  installerArgs,
  installerProduct,
  isNewerVersion,
  isReleaseAsset,
  routeDownloadUrl
} from '../src/main/updates/signed-manifest-driver'
import type { SignedManifestDeps } from '../src/main/updates/signed-manifest-driver'
import type { UpdaterDriverEvent } from '../src/main/updates/updater-driver'

/** A throwaway minisign keypair in the base64-wrapped format Tauri uses. */
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

const repository = 'https://github.com/owner/repo'
const direct = `${repository}/releases/download/channel-stable`
const experimental = `${repository}/releases/download/channel-experimental`
const mirror = `https://ghfast.top/${direct}`
const fileName = 'App-Setup-1.0.0-x64.exe'
const assetUrl = `https://github.com/owner/repo/releases/download/v1.0.0/${fileName}`
const installer = Buffer.from('tauri setup bytes')

type Routes = Record<string, () => Response>

function harness(routes: Routes, overrides: Partial<SignedManifestDeps> = {}) {
  const events: UpdaterDriverEvent[] = []
  const written: Array<{ path: string; data: Uint8Array }> = []
  const disk = new Map<string, Uint8Array>()
  const launched: Array<{ path: string; args: readonly string[] }> = []
  const requested: string[] = []
  let quits = 0
  const deps: SignedManifestDeps = {
    currentVersion: '0.9.31',
    supported: true,
    arch: 'x64',
    publicKey: '',
    product: 'electron',
    repositoryUrl: repository,
    mirrors: ['https://ghfast.top'],
    channel: 'stable',
    fetch: async (url) => {
      requested.push(url)
      const route = routes[url]
      if (!route) throw new Error(`connect ETIMEDOUT ${url}`)
      return route()
    },
    downloadDir: '/tmp/update',
    writeFile: async (path, data) => {
      written.push({ path, data })
      disk.set(path, data)
    },
    readFile: (path) => {
      const data = disk.get(path)
      if (!data) throw new Error(`ENOENT ${path}`)
      return data
    },
    launchInstaller: (path, args) => { launched.push({ path, args }) },
    requestQuit: () => { quits += 1 },
    ...overrides
  }
  const driver = new SignedManifestUpdaterDriver(deps)
  driver.onEvent((event) => events.push(event))
  const settle = async (from = 0): Promise<void> => {
    for (let index = 0; index < 50; index += 1) {
      const last = events.length > from ? events.at(-1)?.kind : undefined
      if (last === 'downloaded' || last === 'error' || last === 'not-available') return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  return { driver, events, written, launched, requested, disk, settle, quits: () => quits }
}

function manifest(signature: string, version = '1.0.0'): () => Response {
  return () => Response.json({
    version,
    notes: 'notes',
    pub_date: '2026-10-21T00:00:00Z',
    platforms: { 'windows-x86_64': { url: assetUrl, signature } }
  })
}

const notFound = (): Response => new Response('Not Found', { status: 404 })
const asset = (data: Buffer = installer) => (): Response =>
  new Response(data, { headers: { 'content-length': String(data.byteLength) } })

describe('SignedManifestUpdaterDriver', () => {
  it('is unsupported without a pinned key or on an unknown architecture', () => {
    expect(harness({}).driver.supported).toBe(false)
    const key = makeKey()
    expect(harness({}, { publicKey: key.publicKey }).driver.supported).toBe(true)
    expect(harness({}, { publicKey: key.publicKey, arch: 'ia32' }).driver.supported).toBe(false)
  })

  it('reports not-available while the latest release has no signed manifest', async () => {
    const key = makeKey()
    const h = harness({ [`${direct}/latest.json`]: notFound, [`${mirror}/latest.json`]: notFound }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.map((event) => event.kind)).toEqual(['checking', 'not-available'])
  })

  it('reports a connection error when no source answers', async () => {
    const key = makeKey()
    const h = harness({}, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    const last = h.events.at(-1)
    expect(last?.kind).toBe('error')
    expect(last && 'message' in last ? last.message : '').toMatch(/无法连接更新源/)
  })

  it('downloads through the mirror that served the manifest, verifies, and installs on quit', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const h = harness({
      [`${mirror}/latest.json`]: manifest(signature),
      [`https://ghfast.top/${assetUrl}`]: asset()
    }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.map((event) => event.kind)).toEqual(['checking', 'available', 'download-progress', 'downloaded'])
    expect(h.events[1]).toEqual({ kind: 'available', version: '1.0.0', releaseNotes: 'notes', product: 'electron' })
    expect(h.written.map((entry) => entry.path)).toEqual([`/tmp/update/${fileName}`])
    expect(h.requested).toContain(`https://ghfast.top/${assetUrl}`)
    h.driver.quitAndInstall()
    expect(h.quits()).toBe(1)
    expect(h.launched).toEqual([])
    // The quit flow disposes the driver after restoring the proxy.
    h.driver.dispose()
    expect(h.launched).toEqual([{ path: `/tmp/update/${fileName}`, args: ['--updated', '/S', '--force-run'] }])
    h.driver.dispose()
    expect(h.launched).toHaveLength(1)
  })

  it('discards a validly signed older installer announced under a newer version', async () => {
    const key = makeKey()
    const oldSignature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:0.9.0`)
    const h = harness({
      [`${direct}/latest.json`]: manifest(oldSignature),
      [assetUrl]: asset()
    }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    const last = h.events.at(-1)
    expect(last?.kind).toBe('error')
    expect(last && 'message' in last ? last.message : '').toMatch(/签名校验失败/)
    expect(h.written).toEqual([])
    h.driver.dispose()
    expect(h.launched).toEqual([])
  })

  it('discards tampered bytes and signatures from another key', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const tampered = harness({
      [`${direct}/latest.json`]: manifest(signature),
      [assetUrl]: asset(Buffer.from('evil bytes'))
    }, { publicKey: key.publicKey })
    tampered.driver.check()
    await tampered.settle()
    expect(tampered.events.at(-1)?.kind).toBe('error')
    expect(tampered.written).toEqual([])

    const foreign = harness({
      [`${direct}/latest.json`]: manifest(makeKey().signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)),
      [assetUrl]: asset()
    }, { publicKey: key.publicKey })
    foreign.driver.check()
    await foreign.settle()
    expect(foreign.events.at(-1)?.kind).toBe('error')
    expect(foreign.written).toEqual([])
  })

  it('does not let a stale mirror hide a release the direct feed lists', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const h = harness({
      [`${mirror}/latest.json`]: notFound,
      [`${direct}/latest.json`]: manifest(signature),
      [assetUrl]: asset()
    }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.map((event) => event.kind)).toEqual(['checking', 'available', 'download-progress', 'downloaded'])
  })

  it('takes the newest offer, not the first source to answer', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const older = key.signFile(installer, `timestamp:0\tfile:${fileName}\tversion:0.9.40`)
    const routes: Routes = {
      [`${mirror}/latest.json`]: manifest(older, '0.9.40'),
      [`${direct}/latest.json`]: manifest(signature),
      [assetUrl]: asset()
    }
    const h = harness(routes, {
      publicKey: key.publicKey,
      // The replaying mirror answers at once; GitHub answers later.
      fetch: async (url) => {
        if (url === `${direct}/latest.json`) await new Promise((resolve) => setTimeout(resolve, 20))
        const route = routes[url]
        if (!route) throw new Error(`connect ETIMEDOUT ${url}`)
        return route()
      }
    })
    h.driver.check()
    await h.settle()
    expect(h.events.find((event) => event.kind === 'available')).toMatchObject({ version: '1.0.0' })
    expect(h.events.at(-1)?.kind).toBe('downloaded')
  })

  it('never downloads from a manifest URL outside the repository releases', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const h = harness({
      [`${direct}/latest.json`]: () => Response.json({
        version: '1.0.0',
        platforms: { 'windows-x86_64': { url: `http://127.0.0.1:9090/${fileName}`, signature } }
      })
    }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.at(-1)?.kind).toBe('error')
    expect(h.requested.some((url) => url.includes('127.0.0.1'))).toBe(false)
  })

  it('falls back to the next source when a mirror serves bad bytes', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const h = harness({
      [`${mirror}/latest.json`]: manifest(signature),
      [`https://ghfast.top/${assetUrl}`]: asset(Buffer.from('truncated')),
      [assetUrl]: asset()
    }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.at(-1)?.kind).toBe('downloaded')
    expect(h.written).toHaveLength(1)
  })

  it('refuses to launch a staged installer that was swapped after verification', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const h = harness({ [`${direct}/latest.json`]: manifest(signature), [assetUrl]: asset() }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.at(-1)?.kind).toBe('downloaded')
    h.disk.set(`/tmp/update/${fileName}`, Buffer.from('swapped by another process'))
    h.driver.dispose()
    expect(h.launched).toEqual([])
  })

  it('does not download the same release again while it waits for quit', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const h = harness({ [`${direct}/latest.json`]: manifest(signature), [assetUrl]: asset() }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    const before = h.events.length
    h.driver.check()
    await h.settle(before)
    expect(h.events.slice(before).map((event) => event.kind)).toEqual(['checking', 'not-available'])
    expect(h.written).toHaveLength(1)
    h.driver.dispose()
    expect(h.launched).toHaveLength(1)
  })

  it('retires the staged installer when a newer release then fails to download', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const routes: Routes = { [`${direct}/latest.json`]: manifest(signature), [assetUrl]: asset() }
    const h = harness(routes, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    const nextName = 'App-Setup-1.0.1-x64.exe'
    routes[`${direct}/latest.json`] = () => Response.json({
      version: '1.0.1',
      platforms: {
        'windows-x86_64': {
          url: `https://github.com/owner/repo/releases/download/v1.0.1/${nextName}`,
          signature: key.signFile(installer, `timestamp:2\tfile:${nextName}\tversion:1.0.1`)
        }
      }
    })
    const before = h.events.length
    h.driver.check()
    await h.settle(before)
    expect(h.events.at(-1)?.kind).toBe('error')
    h.driver.quitAndInstall()
    expect(h.quits()).toBe(0)
    h.driver.dispose()
    expect(h.launched).toEqual([])
  })

  it('ignores manifests that are not newer than the running build', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:0.9.31`)
    const h = harness({ [`${direct}/latest.json`]: manifest(signature, '0.9.31') }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.map((event) => event.kind)).toEqual(['checking', 'not-available'])
  })
  it('switches to the experimental build whatever its version, and back', async () => {
    const key = makeKey()
    const tauriName = 'App_0.1.0_x64-setup.exe'
    const tauriUrl = `https://github.com/owner/repo/releases/download/tauri-v0.1.0/${tauriName}`
    const routes: Routes = {
      [`${direct}/latest.json`]: notFound,
      [`${experimental}/latest.json`]: () => Response.json({
        version: '0.1.0',
        notes: 'tauri notes',
        platforms: { 'windows-x86_64': { url: tauriUrl, signature: key.signFile(installer, `timestamp:1\tfile:${tauriName}\tversion:0.1.0`) } }
      }),
      [tauriUrl]: asset()
    }
    const h = harness(routes, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.map((event) => event.kind)).toEqual(['checking', 'not-available'])

    h.driver.setChannel('experimental')
    const before = h.events.length
    h.driver.check()
    await h.settle(before)
    expect(h.events[before + 1]).toEqual({ kind: 'available', version: '0.1.0', releaseNotes: 'tauri notes', product: 'tauri' })
    expect(h.events.at(-1)?.kind).toBe('downloaded')

    // Back to stable before quitting: nothing from the experimental channel runs.
    h.driver.setChannel('stable')
    h.driver.dispose()
    expect(h.launched).toEqual([])
  })

  it('drops a download that a channel switch superseded', async () => {
    const key = makeKey()
    const signature = key.signFile(installer, `timestamp:1\tfile:${fileName}\tversion:1.0.0`)
    const routes: Routes = { [`${direct}/latest.json`]: manifest(signature), [assetUrl]: asset() }
    const h = harness(routes, {
      publicKey: key.publicKey,
      fetch: async (url) => {
        if (url === assetUrl) await new Promise((resolve) => setTimeout(resolve, 30))
        const route = routes[url]
        if (!route) throw new Error(`connect ETIMEDOUT ${url}`)
        return route()
      }
    })
    h.driver.check()
    for (let index = 0; index < 50 && !h.events.some((event) => event.kind === 'available'); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    h.driver.setChannel('experimental')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.events.map((event) => event.kind)).toEqual(['checking', 'available'])
    expect(h.written).toEqual([])
    h.driver.dispose()
    expect(h.launched).toEqual([])
  })

  it('launches the experimental installer as a takeover', async () => {
    const key = makeKey()
    const tauriName = 'App_0.1.0_x64-setup.exe'
    const tauriUrl = `https://github.com/owner/repo/releases/download/tauri-v0.1.0/${tauriName}`
    const h = harness({
      [`${experimental}/latest.json`]: () => Response.json({
        version: '0.1.0',
        platforms: { 'windows-x86_64': { url: tauriUrl, signature: key.signFile(installer, `timestamp:1\tfile:${tauriName}\tversion:0.1.0`) } }
      }),
      [tauriUrl]: asset()
    }, { publicKey: key.publicKey, channel: 'experimental' })
    h.driver.check()
    await h.settle()
    h.driver.dispose()
    expect(h.launched).toEqual([{ path: `/tmp/update/${tauriName}`, args: ['/P', '/R'] }])
  })

  it('refuses manifests that name an installer of neither build', async () => {
    const key = makeKey()
    const odd = 'App-portable-1.0.0.exe'
    const h = harness({
      [`${direct}/latest.json`]: () => Response.json({
        version: '1.0.0',
        platforms: {
          'windows-x86_64': {
            url: `https://github.com/owner/repo/releases/download/v1.0.0/${odd}`,
            signature: key.signFile(installer, `timestamp:1\tfile:${odd}\tversion:1.0.0`)
          }
        }
      })
    }, { publicKey: key.publicKey })
    h.driver.check()
    await h.settle()
    expect(h.events.at(-1)?.kind).toBe('error')
    expect(h.written).toEqual([])
  })
})

describe('signed manifest helpers', () => {
  it('tells the two builds apart by installer name', () => {
    expect(installerProduct('App_0.9.31_x64-setup.exe')).toBe('tauri')
    expect(installerProduct('App_0.9.31_arm64-setup.exe')).toBe('tauri')
    expect(installerProduct('App-Setup-0.9.31-x64.exe')).toBe('electron')
    expect(installerProduct('App-Setup-0.9.31-arm64.exe')).toBe('electron')
    expect(installerProduct('App-0.9.31.exe')).toBeNull()
  })

  it('runs each installer unattended with a relaunch', () => {
    expect(installerArgs('tauri', 'electron')).toEqual(['/P', '/R'])
    expect(installerArgs('tauri', 'tauri')).toEqual(['/P', '/UPDATE', '/R'])
    expect(installerArgs('electron', 'electron')).toEqual(['--updated', '/S', '--force-run'])
    expect(installerArgs('electron', 'tauri')).toEqual(['/S', '--force-run'])
  })

  it('compares stable versions only', () => {
    expect(isNewerVersion('1.0.0', '0.9.31')).toBe(true)
    expect(isNewerVersion('v0.10.0', '0.9.31')).toBe(true)
    expect(isNewerVersion('0.9.31', '0.9.31')).toBe(false)
    expect(isNewerVersion('0.9.30', '0.9.31')).toBe(false)
    expect(isNewerVersion('1.0.0-beta.1', '0.9.31')).toBe(false)
  })

  it('accepts only this repository release assets', () => {
    expect(isReleaseAsset(assetUrl, repository)).toBe(true)
    expect(isReleaseAsset(assetUrl.replace('https:', 'http:'), repository)).toBe(false)
    expect(isReleaseAsset('https://github.com/other/repo/releases/download/v1/a.exe', repository)).toBe(false)
    expect(isReleaseAsset('https://github.com/owner/repo-evil/releases/download/v1/a.exe', repository)).toBe(false)
    expect(isReleaseAsset(`${assetUrl}?x=1`, repository)).toBe(false)
    expect(isReleaseAsset('not a url', repository)).toBe(false)
  })

  it('routes GitHub assets through the mirror prefix only', () => {
    expect(routeDownloadUrl(assetUrl, direct, direct)).toBe(assetUrl)
    expect(routeDownloadUrl(assetUrl, mirror, direct)).toBe(`https://ghfast.top/${assetUrl}`)
    expect(routeDownloadUrl('https://example.com/a.exe', mirror, direct)).toBe('https://example.com/a.exe')
  })
})
