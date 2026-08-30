import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import process from 'node:process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const brand = JSON.parse(await readFile(join(root, 'brand.config.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(root, 'resources', 'mihomo-assets.json'), 'utf8'))
const requested = process.argv.slice(2)
const arches = requested.includes('--all') ? ['x64', 'arm64'] : requested.filter(value => value === 'x64' || value === 'arm64')
if (arches.length === 0) throw new Error('Usage: node scripts/build-tun-service.mjs --all|x64|arm64')

const suffix = createHash('sha256').update(brand.appId, 'utf8').digest('hex').slice(0, 16)
const identity = {
  serviceName: `ProxyDesktopTun_${suffix}`,
  pipeName: `proxy-desktop-tun-${suffix}`,
  namespaceId: `proxy-desktop-${suffix}`
}

for (const arch of arches) {
  const asset = manifest.assets.find(value => value.platform === 'win32' && value.arch === arch)
  if (!asset) throw new Error(`No pinned Windows mihomo asset for ${arch}`)
  const outputDirectory = join(root, 'resources', 'tun-service', arch)
  await mkdir(outputDirectory, { recursive: true })
  const output = join(outputDirectory, 'tun-service.exe')
  const goArch = arch === 'x64' ? 'amd64' : 'arm64'
  await run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', output, '.'], {
    cwd: join(root, 'native', 'tun-service'),
    env: { ...process.env, GOOS: 'windows', GOARCH: goArch, CGO_ENABLED: '0' }
  })
  await writeFile(join(outputDirectory, 'service-template.json'), JSON.stringify({
    ...identity,
    archiveFilename: asset.filename,
    archiveSha256: asset.sha256,
    archiveInnerName: asset.innerName,
    clientExecutableName: brand.executableName
  }, null, 2) + '\n', 'utf8')
  console.log(`Built Phase 9B TUN service for ${arch}: ${output}`)
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
  })
}
