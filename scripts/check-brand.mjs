import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const brand = JSON.parse(await readFile(join(root, 'brand.config.json'), 'utf8'))
const required = ['productName', 'shortName', 'appId', 'executableName', 'protocolScheme']
const missing = required.filter((key) => !brand[key])

if (missing.length) {
  throw new Error(`Missing brand keys: ${missing.join(', ')}`)
}

const forbidden = [brand.productName, brand.shortName]
const allowed = new Set(['brand.config.json', 'README.md', 'BRANDING.md'])
const violations = []

async function walk(directory) {
  for (const entry of await readdir(directory)) {
    if (['node_modules', '.git', 'dist', 'out'].includes(entry)) continue
    const path = join(directory, entry)
    const info = await stat(path)
    if (info.isDirectory()) await walk(path)
    else if (!allowed.has(entry) && /\.(ts|vue|css|json|mjs|yaml|yml)$/.test(entry)) {
      const content = await readFile(path, 'utf8')
      for (const value of forbidden) {
        if (value && content.includes(value)) violations.push(`${path}: contains ${value}`)
      }
    }
  }
}

await walk(root)

if (violations.length) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log(`Brand configuration is valid for ${brand.productName}.`)
