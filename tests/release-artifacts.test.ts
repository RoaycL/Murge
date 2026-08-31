import { beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brand = JSON.parse(await readFile(path.join(root, 'brand.config.json'), 'utf8')) as { productName: string; repositoryUrl: string }

describe('release-candidate artifacts', () => {
  beforeAll(async () => {
    await execFileAsync(process.execPath, ['scripts/generate-release-notes.mjs'], { cwd: root })
  })

  it('generates deterministic, fully resolved release notes', async () => {
    const [first] = await Promise.all([readFile(path.join(root, 'dist/RELEASE_NOTES.md'), 'utf8')])
    await execFileAsync(process.execPath, ['scripts/generate-release-notes.mjs'], { cwd: root })
    const second = await readFile(path.join(root, 'dist/RELEASE_NOTES.md'), 'utf8')
    expect(second).toBe(first)
    expect(second).toContain(`${brand.productName} v0.1.3`)
    expect(second).not.toContain('{{')
  })

  it('ships source access for the application and the exact bundled mihomo version', async () => {
    const source = await readFile(path.join(root, 'resources/SOURCE_CODE.md'), 'utf8')
    expect(source).toContain(brand.repositoryUrl)
    expect(source).toContain('MetaCubeX/mihomo/tree/v1.19.30')
    const builder = await readFile(path.join(root, 'electron-builder.config.mjs'), 'utf8')
    expect(builder).toContain("{ from: 'resources/SOURCE_CODE.md', to: 'SOURCE_CODE.md' }")
    expect(builder).toContain("forceCodeSigning: process.env.RELEASE_BUILD === 'true'")
  })
})
