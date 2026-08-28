import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const licensePath = resolve(root, 'LICENSE')
const packagePath = resolve(root, 'package.json')

try {
  await access(licensePath, constants.R_OK)
} catch {
  throw new Error('Public release blocked: the repository GPL-3.0-only LICENSE file is missing.')
}

const text = await readFile(licensePath, 'utf8')
if (!text.includes('GNU GENERAL PUBLIC LICENSE') || !text.includes('Version 3, 29 June 2007') || text.length < 30_000) {
  throw new Error('Public release blocked: LICENSE must contain the complete GNU GPL version 3 text.')
}

const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
if (pkg.license !== 'GPL-3.0-only') {
  throw new Error('Public release blocked: package.json must declare the owner-approved GPL-3.0-only SPDX identifier.')
}

console.log(`Application license check passed: ${pkg.license}`)
