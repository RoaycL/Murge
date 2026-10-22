#!/usr/bin/env node
// Writes the static Tauri updater manifest (`latest.json`) a GitHub Release
// carries, after proving every installer signature against the public key
// pinned in src-tauri/tauri.conf.json (`plugins.updater.pubkey`).
//
// The installers are signed beforehand with
//   npx @tauri-apps/cli@2.12.4 signer sign --app-version <version> <setup.exe>
// which writes `<setup.exe>.sig`. `--app-version` records the version in the
// signature's trusted comment; the app runs with `requireSignedVersion`, so an
// unbound signature would be rejected on every client. Checking it here fails
// the release instead of shipping an update nobody can install.
//
// Usage:
//   node scripts/tauri-updater-manifest.mjs --version 1.0.0 \
//     --x64 dist/<product>_1.0.0_x64-setup.exe --arm64 dist/<product>_1.0.0_arm64-setup.exe \
//     [--notes-file notes.md] [--tag v1.0.0] [--pubkey <base64>] --out dist/latest.json
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The updater's `{{target}}-{{arch}}` keys for the two Windows builds. */
export const PLATFORM_KEYS = { x64: 'windows-x86_64', arm64: 'windows-aarch64' }

/** Decode the base64-wrapped minisign text Tauri uses for keys and signatures. */
function unwrap(base64Text, what) {
  const text = Buffer.from(base64Text.trim(), 'base64').toString('utf8')
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2 || !lines[0].startsWith('untrusted comment:')) {
    throw new Error(`${what} is not a base64-encoded minisign document`)
  }
  return lines
}

/** Parse a Tauri public key (base64 of the minisign `.pub` file). */
export function parsePublicKey(base64Text) {
  const raw = Buffer.from(unwrap(base64Text, 'public key')[1], 'base64')
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('public key is not an Ed25519 minisign key')
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) }
}

/** Parse a Tauri signature (base64 of the minisign `.sig` file). */
export function parseSignature(base64Text) {
  const lines = unwrap(base64Text, 'signature')
  const raw = Buffer.from(lines[1], 'base64')
  const algorithm = raw.subarray(0, 2).toString('latin1')
  if (raw.length !== 74 || (algorithm !== 'Ed' && algorithm !== 'ED')) {
    throw new Error('signature is not an Ed25519 minisign signature')
  }
  const trustedLine = lines[2] ?? ''
  if (!trustedLine.startsWith('trusted comment: ')) throw new Error('signature has no trusted comment')
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64')
  if (globalSignature.length !== 64) throw new Error('signature has no global signature')
  return {
    prehashed: algorithm === 'ED',
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trustedLine.slice('trusted comment: '.length),
    globalSignature
  }
}

function ed25519Key(rawKey) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') }, format: 'jwk' })
}

/**
 * Verify `data` against a Tauri signature and public key, minisign-style:
 * the file signature, then the global signature over signature + trusted
 * comment. Returns the trusted comment's `key:value` fields.
 */
export function verifyMinisign(data, signatureBase64, publicKeyBase64) {
  const publicKey = parsePublicKey(publicKeyBase64)
  const signature = parseSignature(signatureBase64)
  if (!signature.keyId.equals(publicKey.keyId)) {
    throw new Error('signature was made with a different key than the pinned public key')
  }
  const key = ed25519Key(publicKey.key)
  const message = signature.prehashed ? createHash('blake2b512').update(data).digest() : data
  if (!verify(null, message, key, signature.signature)) throw new Error('file signature does not verify')
  const signedComment = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, 'utf8')])
  if (!verify(null, signedComment, key, signature.globalSignature)) throw new Error('trusted comment signature does not verify')
  return Object.fromEntries(
    signature.trustedComment.split('\t').map((field) => {
      const index = field.indexOf(':')
      return index === -1 ? [field, ''] : [field.slice(0, index), field.slice(index + 1)]
    })
  )
}

/** `https://github.com/<owner>/<repo>` from the brand document. */
export function repositoryBase(repositoryUrl) {
  const [owner, repo] = new URL(repositoryUrl).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/')
  if (!owner || !repo) throw new Error(`repositoryUrl is not a GitHub repository: ${repositoryUrl}`)
  return `https://github.com/${owner}/${repo}`
}

/**
 * Build the manifest. `installers` maps `x64`/`arm64` to
 * `{ fileName, data, signature }`; every signature must verify and be bound
 * to `version` and to its own file name.
 */
export function buildManifest({ version, tag, notes, pubDate, repositoryUrl, publicKey, installers }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid version: ${version}`)
  if (!publicKey || !publicKey.trim()) throw new Error('no updater public key is pinned (plugins.updater.pubkey)')
  const releaseTag = tag ?? `v${version}`
  const base = repositoryBase(repositoryUrl)
  const platforms = {}
  for (const [arch, installer] of Object.entries(installers)) {
    const platform = PLATFORM_KEYS[arch]
    if (!platform) throw new Error(`unknown architecture: ${arch}`)
    const fields = verifyMinisign(installer.data, installer.signature, publicKey)
    if (fields.version !== version) {
      throw new Error(`${installer.fileName}: signature is bound to version ${fields.version ?? '(none)'}, expected ${version}; sign with --app-version`)
    }
    if (fields.file !== installer.fileName) {
      throw new Error(`${installer.fileName}: signature names file ${fields.file ?? '(none)'}`)
    }
    platforms[platform] = {
      signature: installer.signature.trim(),
      url: `${base}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(installer.fileName)}`
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error('no installers given')
  return { version, notes: notes ?? '', pub_date: pubDate, platforms }
}

function argValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : (argv[index + 1] ?? null)
}

async function main(argv) {
  const version = argValue(argv, '--version')
  const out = argValue(argv, '--out')
  if (!version || !out) throw new Error('--version and --out are required')
  const brand = JSON.parse(await readFile(resolve(root, 'brand.config.json'), 'utf8'))
  const tauriConfig = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const publicKey = argValue(argv, '--pubkey') ?? tauriConfig.plugins?.updater?.pubkey ?? ''
  const notesFile = argValue(argv, '--notes-file')
  const installers = {}
  for (const arch of Object.keys(PLATFORM_KEYS)) {
    const path = argValue(argv, `--${arch}`)
    if (!path) continue
    installers[arch] = {
      fileName: basename(path),
      data: await readFile(path),
      signature: await readFile(`${path}.sig`, 'utf8')
    }
  }
  const manifest = buildManifest({
    version,
    tag: argValue(argv, '--tag') ?? undefined,
    notes: notesFile ? await readFile(notesFile, 'utf8') : '',
    pubDate: new Date().toISOString(),
    repositoryUrl: brand.repositoryUrl,
    publicKey,
    installers
  })
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`wrote ${out} for ${Object.keys(manifest.platforms).join(', ')}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`tauri-updater-manifest: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
