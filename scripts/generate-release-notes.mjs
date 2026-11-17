import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// Release notes (GitHub release body and the update dialog via latest.json)
// come from this version's section of docs/CHANGELOG.md, so they can't drift
// from the changelog the way a separate hand-kept template did.
const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const brand = JSON.parse(await readFile(resolve(root, 'brand.config.json'), 'utf8'))
const changelog = await readFile(resolve(root, 'docs/CHANGELOG.md'), 'utf8')
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('package version is not valid semver')

function extractSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const heading = new RegExp(`^## v${version.replace(/[.+]/g, '\\$&')}(?:[\\s（(]|$)`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) return null
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

const section = extractSection(changelog, pkg.version)
if (!section) throw new Error(`docs/CHANGELOG.md has no "## v${pkg.version}" section`)
const body = section.replace(/^### /gm, '## ')
const output = `# ${brand.productName} v${pkg.version}\n\n${body}\n`
await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(resolve(root, 'dist/RELEASE_NOTES.md'), output, 'utf8')
console.log(`generated dist/RELEASE_NOTES.md for v${pkg.version}`)
