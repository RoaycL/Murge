import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const licensePath = resolve(root, 'LICENSE')
const packagePath = resolve(root, 'package.json')

try {
  await access(licensePath, constants.R_OK)
} catch {
  throw new Error('Public release blocked: repository LICENSE is missing. The owner must choose the application license first.')
}

const text = await readFile(licensePath, 'utf8')
if (text.trim().length < 100) {
  throw new Error('Public release blocked: LICENSE is empty or incomplete.')
}

const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
if (typeof pkg.license !== 'string' || !pkg.license.trim() || pkg.license === 'UNLICENSED') {
  throw new Error('Public release blocked: package.json must declare the owner-approved SPDX license identifier.')
}

console.log(`Application license check passed: ${pkg.license}`)
