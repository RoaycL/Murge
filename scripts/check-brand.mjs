import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const brand = JSON.parse(await readFile(join(root, 'brand.config.json'), 'utf8'))
const required = ['productName', 'shortName', 'appId', 'executableName', 'protocolScheme']
const missing = required.filter((key) => !brand[key])

if (missing.length) {
  throw new Error(`Missing brand keys: ${missing.join(', ')}`)
}

/**
 * Build-time shape/type validation mirroring the runtime Zod schema in
 * src/shared/schemas/brand.ts. Keeps an invalid brand document from
 * reaching a build or a packaged app.
 */
const checks = [
  ['productName', (v) => typeof v === 'string' && v.trim().length > 0],
  ['shortName', (v) => typeof v === 'string' && v.trim().length > 0],
  ['appId', (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(v)],
  ['executableName', (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v)],
  ['protocolScheme', (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9+.-]*$/.test(v)],
  ['description', (v) => typeof v === 'string'],
  ['companyName', (v) => typeof v === 'string'],
  ['repositoryUrl', (v) => typeof v === 'string'],
  ['supportUrl', (v) => typeof v === 'string'],
  ['copyright', (v) => typeof v === 'string']
]

const typeViolations = checks
  .filter(([key, validate]) => !validate(brand[key]))
  .map(([key]) => `${key}`)

if (typeViolations.length) {
  throw new Error(`Invalid brand values: ${typeViolations.join(', ')}`)
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
