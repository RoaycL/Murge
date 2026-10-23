#!/usr/bin/env node
// Writes the stable release channel's manifest for one Electron release: a
// Tauri-updater-format `latest.json` that the release workflow uploads to the
// fixed `channel-stable` GitHub release, where both builds' updaters look.
//
// The release workflow signs each installer first with
// `tauri signer sign --app-version <version>` (key from the
// TAURI_SIGNING_PRIVATE_KEY secret), leaving `<installer>.sig` next to it.
// Every signature is verified here against the public key pinned in
// brand.config.json (`updatePublicKey`) and must be bound to the release
// version and its own file name, so a wrong key or an unbound signature fails
// the release before the channel moves.
//
// Usage:
//   node scripts/channel-manifest.mjs --version 0.9.31 --tag v0.9.31 --dir dist \
//     --notes-file dist/RELEASE_NOTES.md --out dist/channel-stable/latest.json \
//     [--pubkey <base64>]   # dry runs with a throwaway key only
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_KEYS, buildManifest } from './tauri-updater-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Installer names the updater accepts (SAFE_FILE_NAME in
 * src/main/updates/signed-manifest-driver.ts): GitHub serves them unchanged,
 * whereas it rewrites spaces and other characters in asset names, which
 * would break the signed file name.
 */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/

/** electron-builder's `<product>-Setup-<version>-<arch>.exe` (electron-builder.config.mjs artifactName). */
export function electronInstallerName(productName, version, arch) {
  const name = `${productName}-Setup-${version}-${arch}.exe`
  // Fail the release here rather than publish a channel no client can use.
  if (!SAFE_FILE_NAME.test(name)) {
    throw new Error(`installer name ${name} is not usable by the updater: productName must be ASCII letters, digits, ".", "_" or "-"`)
  }
  return name
}

/** Pick exactly one installer per architecture; a missing one is an error. */
export function selectElectronInstallers(fileNames, productName, version) {
  const installers = {}
  for (const arch of Object.keys(PLATFORM_KEYS)) {
    const expected = electronInstallerName(productName, version, arch)
    if (!fileNames.includes(expected)) throw new Error(`missing installer ${expected}`)
    installers[arch] = expected
  }
  return installers
}

function argValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : (argv[index + 1] ?? null)
}

async function main(argv) {
  const version = argValue(argv, '--version')
  const tag = argValue(argv, '--tag')
  const dir = argValue(argv, '--dir')
  const out = argValue(argv, '--out')
  if (!version || !tag || !dir || !out) throw new Error('--version, --tag, --dir and --out are required')
  const brand = JSON.parse(await readFile(resolve(root, 'brand.config.json'), 'utf8'))
  const publicKey = argValue(argv, '--pubkey') ?? brand.updatePublicKey ?? ''
  const notesFile = argValue(argv, '--notes-file')

  const names = selectElectronInstallers(await readdir(dir), brand.productName, version)
  const installers = {}
  for (const [arch, fileName] of Object.entries(names)) {
    const path = join(dir, fileName)
    installers[arch] = { fileName, data: await readFile(path), signature: await readFile(`${path}.sig`, 'utf8') }
  }
  const manifest = buildManifest({
    version,
    tag,
    notes: notesFile ? await readFile(notesFile, 'utf8') : '',
    pubDate: new Date().toISOString(),
    repositoryUrl: brand.repositoryUrl,
    publicKey,
    installers
  })
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`wrote ${out} for ${Object.values(names).join(', ')}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`channel-manifest: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
