import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const noticesPath = join(root, 'resources', 'THIRD_PARTY_NOTICES.md')
const licensesDir = join(root, 'resources', 'licenses')

// Every package the notices promise to retain, with the bundled license file.
const EXPECTED_LICENSES = [
  'vue.txt',
  'vue-router.txt',
  'pinia.txt',
  'vueuse-core.txt',
  'zod.txt',
  'ws.txt',
  'electron.txt',
  'electron-toolkit-utils.txt',
  'electron-toolkit-preload.txt'
]

describe('third-party notices', () => {
  it('contains no placeholder copyright or year', async () => {
    const notices = await readFile(noticesPath, 'utf8')
    // The original "Copyright (c) <contributors>" placeholder was removed, and
    // no generic author/year stub remains. (Angle-bracket URLs inside license
    // texts are legitimate, so only the placeholder forms are rejected here.)
    expect(notices).not.toMatch(/<contributors>/)
    expect(notices).not.toMatch(/<year>/)
    expect(notices).not.toMatch(/Copyright \(c\) <[^>]+>/)
    expect(notices).not.toMatch(/unknown|copyright holder|TBD|TODO/i)
  })

  it('references a retained license file for every bundled dependency', async () => {
    const notices = await readFile(noticesPath, 'utf8')
    const referenced = [...notices.matchAll(/`licenses\/([a-z0-9-]+\.txt)`/g)].map((m) => m[1])
    expect(referenced.length).toBeGreaterThan(0)
    for (const file of referenced) {
      await expect(readFile(join(licensesDir, file), 'utf8')).resolves.toBeTruthy()
    }
  })

  it('retains a real, non-placeholder license for each promised dependency', async () => {
    for (const file of EXPECTED_LICENSES) {
      const content = await readFile(join(licensesDir, file), 'utf8')
      expect(content.trim().length).toBeGreaterThan(20)
      // Must be a real retained notice, not a placeholder author.
      expect(content).not.toMatch(/Copyright \(c\) <[^>]+>/)
    }
  })
})
