import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'resources/mihomo-assets.json'), 'utf8'))
const windowsAssets = manifest.assets.filter((asset) => asset.platform === 'win32')

// Geodata databases shipped inside the installer (see manifest.geodata). The
// runtime seeds them into the kernel's persistent home, so a profile carrying
// GEOSITE/GEOIP rules starts without any online download — mihomo's built-in
// download needs DNS to resolve its host, which does not exist before a proxy
// is up (the very failure that blocked startup with `Can't find GeoSite.dat`).
const geodataDir = resolve(root, 'resources/geodata')
await mkdir(geodataDir, { recursive: true })
for (const asset of manifest.geodata) {
  const destination = resolve(geodataDir, asset.filename)
  await rm(destination, { force: true })

  const response = await fetch(`${asset.url}`, {
    signal: AbortSignal.timeout(300_000),
    redirect: 'follow'
  })
  if (!response.ok || !response.body) throw new Error(`download failed: ${asset.filename} HTTP ${response.status}`)

  let bytes = 0
  const hash = createHash('sha256')
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(destination))
    const digest = hash.digest('hex')
    if (digest !== asset.sha256) {
      throw new Error(`${asset.filename} verification failed: bytes=${bytes}, sha256=${digest}`)
    }
    console.log(`prepared geodata: ${asset.filename} (${bytes} bytes, sha256=${digest})`)
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
}

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
