import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractZipToDir, ZipFormatError } from '../src/main/substore/substore-zip'
import { buildTestZip } from './helpers/substore-zip-builder'

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'substore-zip-'))
}

describe('extractZipToDir', () => {
  it('extracts stored and deflate entries with nested directories', async () => {
    const dir = await tmpDir()
    try {
      const zipPath = join(dir, 'a.zip')
      const out = join(dir, 'out')
      await writeFile(
        zipPath,
        buildTestZip([
          { name: 'dist/index.html', data: Buffer.from('<html>hi</html>') },
          { name: 'dist/assets/app.js', data: Buffer.from('console.log(1)'), method: 8 },
          { name: 'dist/assets/', data: Buffer.alloc(0) }
        ])
      )
      const written = await extractZipToDir(zipPath, out)
      // The shared dist/ prefix is stripped.
      expect(written.sort()).toEqual(['assets/app.js', 'index.html'])
      expect(await readFile(join(out, 'index.html'), 'utf8')).toBe('<html>hi</html>')
      expect(await readFile(join(out, 'assets/app.js'), 'utf8')).toBe('console.log(1)')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects traversal entries before writing', async () => {
    const dir = await tmpDir()
    try {
      const zipPath = join(dir, 'evil.zip')
      const out = join(dir, 'out')
      await writeFile(
        zipPath,
        buildTestZip([{ name: '../escape.txt', data: Buffer.from('pwn') }])
      )
      await expect(extractZipToDir(zipPath, out)).rejects.toBeInstanceOf(ZipFormatError)
      await expect(readFile(join(dir, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects absolute-path entries', async () => {
    const dir = await tmpDir()
    try {
      const zipPath = join(dir, 'abs.zip')
      const out = join(dir, 'out')
      await writeFile(
        zipPath,
        buildTestZip([{ name: '/etc/passwd', data: Buffer.from('x') }])
      )
      await expect(extractZipToDir(zipPath, out)).rejects.toBeInstanceOf(ZipFormatError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-zip buffer', async () => {
    const dir = await tmpDir()
    try {
      const zipPath = join(dir, 'fake.zip')
      const out = join(dir, 'out')
      await writeFile(zipPath, Buffer.from('definitely not a zip file'))
      await expect(extractZipToDir(zipPath, out)).rejects.toBeInstanceOf(ZipFormatError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('handles the no-top-level-directory layout without stripping', async () => {
    const dir = await tmpDir()
    try {
      const zipPath = join(dir, 'flat.zip')
      const out = join(dir, 'out')
      await writeFile(
        zipPath,
        buildTestZip([
          { name: 'index.html', data: Buffer.from('<html/>') },
          { name: 'main.js', data: Buffer.from('export default 1', 'utf8'), method: 8 }
        ])
      )
      const written = await extractZipToDir(zipPath, out)
      expect(written.sort()).toEqual(['index.html', 'main.js'])
      await mkdir(out, { recursive: true })
      expect(await readFile(join(out, 'index.html'), 'utf8')).toBe('<html/>')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
