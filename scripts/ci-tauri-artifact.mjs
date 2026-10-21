import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [target, arch] = process.argv.slice(2)
const expected = { x64: ['x86_64-pc-windows-msvc', 0x8664], arm64: ['aarch64-pc-windows-msvc', 0xaa64] }[arch]
if (!expected || target !== expected[0]) throw new Error('Unsupported architecture/target pair')
if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required')
const brand = JSON.parse(await readFile('brand.config.json', 'utf8'))
const name = `${brand.executableName}.exe`
const path = resolve('src-tauri', 'target', target, 'release', name)
const bytes = await readFile(path)
if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Missing DOS executable header')
const pe = bytes.readUInt32LE(0x3c)
if (pe + 6 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== expected[1]) throw new Error('Executable PE architecture mismatch')
const output = resolve(process.env.RUNNER_TEMP, `tauri-${arch}`)
await mkdir(output, { recursive: true })
await copyFile(path, resolve(output, name))
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ filename: name, arch, target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), commit: process.env.GITHUB_SHA }, null, 2) + '\n')
console.log(`Verified and staged ${arch} executable (${bytes.length} bytes)`)
