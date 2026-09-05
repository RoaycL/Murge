import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareGeodata } from './prepare-geodata.mjs'
import { discoverMihomoRelease } from './resolve-mihomo-release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(await readFile(resolve(root, 'resources/mihomo-assets.json'), 'utf8'))
let manifest
for (let attempt = 1; attempt <= 3; attempt++) {
  try { manifest = await discoverMihomoRelease(baseline); break }
  catch (error) { if (attempt === 3) throw error }
}
const windowsAssets = manifest.assets.filter((asset) => asset.platform === 'win32')

// Geodata databases shipped inside the installer (see manifest.geodata). The
// runtime seeds them into the kernel's persistent home, so a profile carrying
// GEOSITE/GEOIP rules starts without any online download — mihomo's built-in
// download needs DNS to resolve its host, which does not exist before a proxy
// is up (the very failure that blocked startup with `Can't find GeoSite.dat`).
const geodataDir = resolve(root, 'resources/geodata')
await prepareGeodata(geodataDir, manifest.geodata)

for (const asset of windowsAssets) {
  const destinationDir = resolve(root, 'resources/bin', asset.arch)
  const destination = resolve(destinationDir, asset.filename)
  await mkdir(destinationDir, { recursive: true })
  await rm(destination, { force: true })

  const response = await fetch(`${manifest.releaseBase}/${asset.filename}`, {
    signal: AbortSignal.timeout(120_000),
    redirect: 'follow'
  })
  if (!response.ok || !response.body) throw new Error(`download failed: ${asset.filename} HTTP ${response.status}`)

  let bytes = 0
  const hash = createHash('sha256')
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > asset.size) return callback(new Error(`mihomo archive size exceeded: ${asset.filename}`))
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(destination))
    const digest = hash.digest('hex')
    if (bytes !== asset.size || digest !== asset.sha256) {
      throw new Error(`${asset.filename} verification failed: bytes=${bytes}, sha256=${digest}`)
    }
    console.log(`prepared ${asset.arch}: ${asset.filename} (${bytes} bytes, sha256=${digest})`)
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
}

// Publish the lock only after every bundled Windows archive has verified.
// Main-process build, TUN service template and packaged evidence share this lock.
const lock = resolve(root, 'resources/mihomo-resolved.json')
await writeFile(`${lock}.tmp`, JSON.stringify(manifest, null, 2) + '\n')
await rename(`${lock}.tmp`, lock)
const source = await readFile(resolve(root, 'resources/SOURCE_CODE.md'), 'utf8')
await writeFile(resolve(root, 'resources/SOURCE_CODE.resolved.md'), source.replaceAll(baseline.version, manifest.version))
console.log(`Resolved bundled mihomo: ${manifest.version}`)
