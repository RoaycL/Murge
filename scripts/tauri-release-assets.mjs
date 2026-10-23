#!/usr/bin/env node
// Signs the Tauri NSIS installers of one release and writes the files the
// GitHub Release carries next to them: `latest.json` (the signed updater
// manifest, see tauri-updater-manifest.mjs) and `SHA256SUMS.txt`.
//
// The private key comes from TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD), exactly
// as `tauri signer sign` reads it. Each signature is bound to the release
// version (`--app-version`), and the manifest step re-verifies every signature
// against the public key pinned in src-tauri/tauri.conf.json, so a wrong key
// or an unbound signature fails the release before anything is published.
//
// Usage:
//   node scripts/tauri-release-assets.mjs --version 0.9.31 --tag tauri-v0.9.31 \
//     --dir <folder with <product>_0.9.31_x64-setup.exe and <product>_0.9.31_arm64-setup.exe> \
//     [--notes-file <release notes, shown in the update dialog>] \
//     [--pubkey <base64>]   # dry runs with a throwaway key only
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_KEYS, buildManifest } from './tauri-updater-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** `<product>_<version>_<arch>-setup.exe`, the bundler's own NSIS name. */
export function installerName(productName, version, arch) {
  return `${productName}_${version}_${arch}-setup.exe`
}

/** Pick exactly one installer per architecture; anything else is an error. */
export function selectInstallers(fileNames, productName, version) {
  const installers = {}
  for (const arch of Object.keys(PLATFORM_KEYS)) {
    const expected = installerName(productName, version, arch)
    if (!fileNames.includes(expected)) throw new Error(`missing installer ${expected}`)
    installers[arch] = expected
  }
  const extra = fileNames.filter((name) => name.endsWith('-setup.exe') && !Object.values(installers).includes(name))
  if (extra.length > 0) throw new Error(`unexpected installers: ${extra.join(', ')}`)
  return installers
}

function argValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : (argv[index + 1] ?? null)
}

function sign(file, version) {
  const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  return new Promise((resolvePromise, reject) => {
    // The key and password stay in the inherited environment, never in argv.
    const child = spawn(process.execPath, [cli, 'signer', 'sign', '--app-version', version, file], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit']
    })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`signing ${file} failed (exit ${code})`))))
  })
}

async function main(argv) {
  const version = argValue(argv, '--version')
  const tag = argValue(argv, '--tag')
  const dir = argValue(argv, '--dir')
  if (!version || !tag || !dir) throw new Error('--version, --tag and --dir are required')
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('TAURI_SIGNING_PRIVATE_KEY is not set')

  const brand = JSON.parse(await readFile(resolve(root, 'brand.config.json'), 'utf8'))
  const tauriConfig = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const productName = tauriConfig.productName
  const publicKey = argValue(argv, '--pubkey') ?? tauriConfig.plugins?.updater?.pubkey ?? ''

  const names = selectInstallers(await readdir(dir), productName, version)
  const installers = {}
  const checksums = []
  for (const [arch, fileName] of Object.entries(names)) {
    const path = join(dir, fileName)
    await sign(path, version)
    const data = await readFile(path)
    installers[arch] = { fileName, data, signature: await readFile(`${path}.sig`, 'utf8') }
    checksums.push(`${createHash('sha256').update(data).digest('hex')} *${fileName}`)
  }

  const notesFile = argValue(argv, '--notes-file')
  const manifest = buildManifest({
    version,
    tag,
    notes: notesFile ? await readFile(notesFile, 'utf8') : '',
    pubDate: new Date().toISOString(),
    repositoryUrl: brand.repositoryUrl,
    publicKey,
    installers
  })
  await writeFile(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(dir, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`)
  process.stdout.write(`signed ${Object.values(names).join(', ')}; wrote latest.json and SHA256SUMS.txt\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`tauri-release-assets: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
