import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, win32 } from 'node:path'

const root = process.cwd()
const manifest = JSON.parse(await readFile(resolve(root, 'resources/mihomo-assets.json'), 'utf8'))
const platform = process.platform
const assets = manifest.assets.filter((asset) => asset.platform === platform && asset.arch === process.arch)
if (assets.length !== 1) throw new Error(`Expected one pinned asset for ${platform}/${process.arch}`)
for (const asset of assets) {
  const destination = resolve(root, 'resources/bin', asset.arch, asset.filename)
  await mkdir(dirname(destination), { recursive: true })
  const valid = (bytes) => bytes.length === asset.size && createHash('sha256').update(bytes).digest('hex') === asset.sha256
  const cached = await readFile(destination).catch(() => null)
  if (!cached || !valid(cached)) {
    const response = await fetch(`${manifest.releaseBase}/${asset.filename}`, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body) throw new Error(`Pinned asset download: HTTP ${response.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > asset.size) throw new Error('Pinned asset exceeds manifest size')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    if (!valid(bytes)) throw new Error('Pinned asset size or SHA-256 mismatch')
    const temporary = `${destination}.ci.tmp`
    try { await writeFile(temporary, bytes); await rename(temporary, destination) }
    finally { await rm(temporary, { force: true }) }
  }
  console.log(`Pinned asset verified: ${asset.filename}`)
}
const fixture = await realpath(process.execPath)
const temporary = await realpath(tmpdir())
// The supervisor intentionally clears its environment, so PATH alone is not
// enough. Canonical temp paths also keep missing-member traversal tests from
// comparing a symlink/verbatim prefix with a non-canonical fallback path.
const canonicalTemp = platform === 'win32' ? win32.toNamespacedPath(temporary) : temporary
if (process.env.GITHUB_ENV) {
  await appendFile(process.env.GITHUB_ENV, `MURGE_KERNEL_FIXTURE_COMMAND=${fixture}\nTMPDIR=${canonicalTemp}\nTMP=${canonicalTemp}\nTEMP=${canonicalTemp}\n`)

}
console.log(`Node fixture prepared: ${fixture}`)
