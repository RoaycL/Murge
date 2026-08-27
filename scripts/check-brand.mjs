import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve the repo root from this module's URL. fileURLToPath handles the
// Windows file:///C:/... form and percent-encoding, so the path stays valid on
// every platform (the raw .pathname form breaks on Windows spaces/encoding).
const root = fileURLToPath(new URL('..', import.meta.url))
const schemaPath = join(root, 'docs', 'schemas', 'brand.schema.json')
const brandPath = join(root, 'brand.config.json')

const brand = JSON.parse(await readFile(brandPath, 'utf8'))
const schema = JSON.parse(await readFile(schemaPath, 'utf8'))

const properties = schema.properties ?? {}
const required = Array.isArray(schema.required) ? schema.required : []

/**
 * Validate `brand.config.json` against `docs/schemas/brand.schema.json` so the
 * JSON Schema is the single source of truth for shape and format. The runtime
 * Zod schema mirrors the same patterns; a unit test keeps the two in sync.
 */
const missing = required.filter((key) => brand[key] === undefined)
if (missing.length) {
  throw new Error(`Missing brand keys: ${missing.join(', ')}`)
}

const allowedKeys = new Set([...Object.keys(properties), '$schema'])
const unknownKeys = Object.keys(brand).filter((key) => !allowedKeys.has(key))
if (schema.additionalProperties === false && unknownKeys.length) {
  throw new Error(`Unknown brand keys: ${unknownKeys.join(', ')}`)
}

const violations = []
for (const key of Object.keys(brand)) {
  const prop = properties[key]
  if (!prop) continue
  const value = brand[key]
  if (Array.isArray(value)) {
    // Array-typed brand fields are the legacy namespace catalogs. Each element
    // must be a non-empty string that is a safe, relative directory name so the
    // migration can never escape the app-data root via a crafted namespace.
    if (prop.type === 'array') {
      if (typeof prop.minItems === 'number' && value.length < prop.minItems) {
        violations.push(`${key}: must contain at least ${prop.minItems} entr${prop.minItems === 1 ? 'y' : 'ies'}`)
        continue
      }
      for (const item of value) {
        if (typeof item !== 'string' || item.length === 0) {
          violations.push(`${key}: each entry must be a non-empty string`)
        } else if (/[\\/]/.test(item) || item === '.' || item === '..') {
          violations.push(`${key}: "${item}" is not a safe directory name`)
        }
      }
    } else {
      violations.push(`${key}: must be a string`)
    }
    continue
  }
  if (typeof value !== 'string') {
    violations.push(`${key}: must be a string`)
    continue
  }
  if (typeof prop.minLength === 'number' && value.length < prop.minLength) {
    violations.push(`${key}: must be at least ${prop.minLength} character(s)`)
  }
  if (typeof prop.pattern === 'string' && !new RegExp(prop.pattern).test(value)) {
    violations.push(`${key}: "${value}" does not match ${prop.pattern}`)
  }
}

// Rename safety: the migration coverage must come from the explicit legacy
// catalogs, never from the current product name. Require at least one usable
// namespace so a release never ships with zero migration coverage, and so a
// rename cannot silently drop every historical application-data folder.
const legacyNamespaces = [
  ...(brand.legacyProductNames ?? []),
  ...(brand.legacyAppDataNamespaces ?? [])
].filter((name) => name && name !== brand.appId)
if (!legacyNamespaces.length) {
  violations.push(
    'legacyProductNames/legacyAppDataNamespaces: must configure at least one legacy namespace to migrate'
  )
}
// A rename must never auto-change the durable namespace identity; the migration
// coverage is tied to the explicit catalogs above, not to `productName`.
if (brand.legacyProductNames?.includes(brand.appId)) {
  violations.push('legacyProductNames: the appId namespace is not a legacy namespace')
}

if (violations.length) {
  throw new Error(`Invalid brand values:\n${violations.map((v) => `  - ${v}`).join('\n')}`)
}

const forbidden = [brand.productName, brand.shortName]
const allowed = new Set(['brand.config.json', 'README.md', 'BRANDING.md'])
const scanViolations = []

async function walk(directory) {
  for (const entry of await readdir(directory)) {
    if (['node_modules', '.git', 'dist', 'out'].includes(entry)) continue
    const path = join(directory, entry)
    const info = await stat(path)
    if (info.isDirectory()) await walk(path)
    else if (!allowed.has(entry) && /\.(ts|vue|css|json|mjs|yaml|yml)$/.test(entry)) {
      const content = await readFile(path, 'utf8')
      for (const value of forbidden) {
        if (value && content.includes(value)) scanViolations.push(`${path}: contains ${value}`)
      }
    }
  }
}

await walk(root)

if (scanViolations.length) {
  console.error(scanViolations.join('\n'))
  process.exit(1)
}

console.log(`Brand configuration is valid for ${brand.productName}.`)
