import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const template = await readFile(resolve(root, 'docs/release-notes-template.md'), 'utf8')
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('package version is not valid semver')
if (!template.includes('{{VERSION}}')) throw new Error('release notes template is missing {{VERSION}}')
const output = template.replaceAll('{{VERSION}}', `v${pkg.version}`)
if (output.includes('{{')) throw new Error('release notes contain unresolved template markers')
await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(resolve(root, 'dist/RELEASE_NOTES.md'), output, 'utf8')
console.log(`generated dist/RELEASE_NOTES.md for v${pkg.version}`)
