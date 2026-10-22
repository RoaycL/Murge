// Build the per-machine NSIS installers for the Tauri shell, one per arch.
//
// The Tauri counterpart of `electron-builder.config.mjs` + `npm run package:win`.
// tauri.conf.json cannot vary resources by arch, so this script verifies the
// prepared per-arch inputs and passes them to `tauri build` as a config
// overlay. Installed layout matches the Electron build (everything under
// `$INSTDIR\resources\`), which is what `tun-service.exe --install` and the
// hooks in src-tauri/nsis/hooks.nsh rely on.
//
// Prerequisites (same as package:win): `npm run kernel:prepare` and
// `npm run tun-service:build`. Usage: node scripts/tauri-package.mjs --all|x64|arm64
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const RUST_TARGETS = {
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc'
}

// Installed relative to $INSTDIR. Kept in step with the Electron
// `extraResources` list so both builds install the same tree.
const GEODATA_PATTERN = /\.(dat|metadb|mmdb)$|^resolved-assets\.json$/

export function resolvedManifest(base = root) {
  const path = join(base, 'resources', 'mihomo-resolved.json')
  if (!existsSync(path)) throw new Error('resources/mihomo-resolved.json is missing: run npm run kernel:prepare first')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function requireFile(path, hint) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${relative(root, path) || path}: ${hint}`)
  return path
}

function listFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

/**
 * The `bundle.resources` map for one arch: absolute source path -> path under
 * $INSTDIR. Verifies everything the installer hooks and the service installer
 * need, so a broken input fails the build instead of the user's install.
 */
export function bundleResources(arch, { base = root, manifest = resolvedManifest(base) } = {}) {
  if (!RUST_TARGETS[arch]) throw new Error(`Unsupported arch: ${arch}`)
  const resources = join(base, 'resources')
  const asset = manifest.assets.find((value) => value.platform === 'win32' && value.arch === arch)
  if (!asset) throw new Error(`No pinned Windows mihomo asset for ${arch}`)
  const map = {}
  const add = (source, target) => { map[source] = target }

  const archive = requireFile(join(resources, 'bin', arch, asset.filename), 'run npm run kernel:prepare')
  if (sha256File(archive) !== asset.sha256) throw new Error(`${asset.filename} does not match its pinned sha256`)
  add(archive, `resources/bin/${asset.filename}`)

  const serviceDir = join(resources, 'tun-service', arch)
  const serviceExe = requireFile(join(serviceDir, 'tun-service.exe'), 'run npm run tun-service:build')
  const templatePath = requireFile(join(serviceDir, 'service-template.json'), 'run npm run tun-service:build')
  const template = JSON.parse(readFileSync(templatePath, 'utf8'))
  if (template.archiveFilename !== asset.filename || template.archiveSha256 !== asset.sha256) {
    throw new Error(`resources/tun-service/${arch}/service-template.json is stale: rerun npm run tun-service:build`)
  }
  const brand = JSON.parse(readFileSync(join(base, 'brand.config.json'), 'utf8'))
  if (template.clientExecutableName !== brand.executableName) {
    throw new Error('service-template.json clientExecutableName must equal brand.executableName')
  }
  add(serviceExe, 'resources/tun-service/tun-service.exe')
  add(templatePath, 'resources/tun-service/service-template.json')

  add(requireFile(join(resources, 'startup', 'register-task.ps1'), 'checked-in file'), 'resources/startup/register-task.ps1')
  for (const file of listFiles(join(resources, 'defaults'))) {
    add(file, `resources/defaults/${relative(join(resources, 'defaults'), file).split(sep).join('/')}`)
  }

  const geodataDir = join(resources, 'geodata')
  const geodata = existsSync(geodataDir) ? readdirSync(geodataDir).filter((name) => GEODATA_PATTERN.test(name)).sort() : []
  for (const expected of manifest.geodata ?? []) {
    const name = expected.outputFilename ?? expected.filename
    if (!geodata.includes(name)) throw new Error(`Missing resources/geodata/${name}: run npm run kernel:prepare`)
  }
  for (const name of geodata) add(join(geodataDir, name), `resources/geodata/${name}`)

  add(requireFile(join(base, 'LICENSE'), 'checked-in file'), 'resources/LICENSE.txt')
  add(requireFile(join(resources, 'THIRD_PARTY_NOTICES.md'), 'checked-in file'), 'resources/THIRD_PARTY_NOTICES.md')
  add(requireFile(join(resources, 'SOURCE_CODE.resolved.md'), 'run npm run kernel:prepare'), 'resources/SOURCE_CODE.md')
  add(join(resources, 'mihomo-resolved.json'), 'resources/mihomo-resolved.json')
  for (const file of listFiles(join(resources, 'licenses'))) {
    add(file, `resources/licenses/${relative(join(resources, 'licenses'), file).split(sep).join('/')}`)
  }
  return map
}

/** The `tauri build --config` overlay. JSON merge patch keeps the base tray map. */
export function configOverlay(arch, options) {
  return { bundle: { resources: bundleResources(arch, options) } }
}

export function parseArches(args) {
  const arches = args.includes('--all') ? ['x64', 'arm64'] : args.filter((value) => value in RUST_TARGETS)
  if (arches.length === 0) throw new Error('Usage: node scripts/tauri-package.mjs --all|x64|arm64')
  return arches
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))))
  })
}

async function main() {
  const arches = parseArches(process.argv.slice(2))
  const workDirectory = mkdtempSync(join(tmpdir(), 'tauri-package-'))
  const tauriCli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  for (const arch of arches) {
    const overlayPath = join(workDirectory, `bundle-${arch}.json`)
    writeFileSync(overlayPath, JSON.stringify(configOverlay(arch), null, 2) + '\n')
    const target = RUST_TARGETS[arch]
    await run(process.execPath, [tauriCli, 'build', '--target', target, '--bundles', 'nsis', '--config', overlayPath, '--ci'])
    // Keep the bundler's own `<product>_<version>_<arch>-setup.exe` name: the
    // updater manifest script matches it.
    const outputDirectory = join(root, 'src-tauri', 'target', target, 'release', 'bundle', 'nsis')
    const installers = readdirSync(outputDirectory).filter((name) => name.endsWith('-setup.exe'))
    if (installers.length === 0) throw new Error(`No NSIS installer produced in ${outputDirectory}`)
    for (const name of installers) {
      const path = join(outputDirectory, name)
      const digest = sha256File(path)
      writeFileSync(`${path}.sha256`, `${digest}  ${name}\n`)
      console.log(`Built ${arch} installer: ${path} sha256=${digest}`)
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
