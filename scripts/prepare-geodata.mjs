import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const API = 'https://api.github.com/repos/MetaCubeX/meta-rules-dat/releases/tags/latest'
const BASE = 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/'

export function resolveGeodata(release, requested) {
  if (!Number.isSafeInteger(release?.id) || !Array.isArray(release.assets)) throw new Error('Invalid geodata release metadata')
  return requested.map(({ filename }) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(filename) || filename === '.' || filename === '..') throw new Error('Invalid geodata filename')
    const matches = release.assets.filter((asset) => asset.name === filename)
    const asset = matches[0]
    if (matches.length !== 1 || !Number.isSafeInteger(asset.id) ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 128 * 1024 * 1024 ||
        !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '') || asset.browser_download_url !== BASE + filename) {
      throw new Error(`Missing or invalid upstream digest/size/asset: ${filename}`)
    }
    return { filename, assetId: asset.id, url: asset.browser_download_url, size: asset.size, sha256: asset.digest.slice(7).toLowerCase(), updatedAt: asset.updated_at }
  })
}

/** Resolve one release per attempt, stage and verify the whole set before publishing. */
export async function prepareGeodata(directory, requested, { fetchFn = fetch, token = process.env.GITHUB_TOKEN, attempts = 3 } = {}) {
  await mkdir(directory, { recursive: true })
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const staging = await mkdtemp(join(directory, '.download-'))
    try {
      const response = await fetchFn(API, {
        headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(30_000), redirect: 'error'
      })
      if (!response.ok) throw new Error(`Geodata release lookup: HTTP ${response.status}`)
      const release = await response.json()
      const assets = resolveGeodata(release, requested)
      for (const asset of assets) {
        // Credentials are used only for the API request, never asset redirects.
        const download = await fetchFn(asset.url, { signal: AbortSignal.timeout(300_000), redirect: 'follow' })
        if (!download.ok || !download.body) throw new Error(`Geodata download: ${asset.filename} HTTP ${download.status}`)
        const hash = createHash('sha256')
        let bytes = 0
        const hashing = new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length
          if (bytes > asset.size) return callback(new Error(`Geodata size exceeded: ${asset.filename}`))
          hash.update(chunk)
          callback(null, chunk)
        } })
        await pipeline(Readable.fromWeb(download.body), hashing, createWriteStream(join(staging, asset.filename)))
        if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error(`Geodata verification failed: ${asset.filename}`)
      }
      const provenance = { releaseId: release.id, tag: release.tag_name, preparedAt: new Date().toISOString(), assets }
      await writeFile(join(staging, 'resolved-assets.json'), JSON.stringify(provenance, null, 2) + '\n')
      for (const asset of assets) await rename(join(staging, asset.filename), join(directory, asset.filename))
      await rename(join(staging, 'resolved-assets.json'), join(directory, 'resolved-assets.json'))
      console.log(`Prepared geodata release ${release.id}: ${assets.map((a) => `${a.filename} sha256=${a.sha256}`).join(', ')}`)
      return provenance
    } catch (error) {
      if (attempt === attempts) throw error
      console.warn(`Geodata attempt ${attempt} failed; resolving latest again: ${error.message}`)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  throw new Error('No geodata download attempts configured')
}
