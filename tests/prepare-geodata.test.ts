import { it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareGeodata } from '../scripts/prepare-geodata.mjs'

const requested = [{ filename: 'geosite.dat' }]
function metadata(content, digest = 'sha256:' + createHash('sha256').update(content).digest('hex')) {
  return { id: 123, tag_name: 'latest', assets: [{ id: 456, name: 'geosite.dat', size: Buffer.byteLength(content), digest,
    browser_download_url: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat' }] }
}

it('refreshes metadata after a latest race and records only verified resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geodata-test-'))
  let lookups = 0
  try {
    const result = await prepareGeodata(directory, requested, { token: 'test-token', fetchFn: async (url, options) => {
      if (url.startsWith('https://api.github.com/')) {
        expect(options.headers.Authorization).toBe('Bearer test-token')
        return Response.json(metadata(++lookups === 1 ? 'old' : 'new'))
      }
      expect(options.headers).toBeUndefined()
      return new Response('new')
    } })
    expect(lookups).toBe(2)
    expect(await readFile(join(directory, 'geosite.dat'), 'utf8')).toBe('new')
    expect(JSON.parse(await readFile(join(directory, 'resolved-assets.json'), 'utf8'))).toEqual(result)
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['geosite.dat', 'resolved-assets.json']))
    expect((await readdir(directory)).some((name) => name.startsWith('.download-'))).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.each(['missing-digest', 'wrong-content', 'oversize', 'http-error'])('rejects %s without replacing previous data', async (failure) => {
  const directory = await mkdtemp(join(tmpdir(), 'geodata-test-'))
  let lookups = 0
  try {
    await writeFile(join(directory, 'geosite.dat'), 'previous')
    await expect(prepareGeodata(directory, requested, { attempts: 2, fetchFn: async (url) => {
      if (url.startsWith('https://api.github.com/')) {
        lookups++
        return Response.json(metadata('new', failure === 'missing-digest' ? null : undefined))
      }
      return failure === 'http-error' ? new Response('error', { status: 503 }) : new Response(failure === 'oversize' ? 'too large' : 'bad')
    } })).rejects.toThrow()
    expect(lookups).toBe(2)
    expect(await readFile(join(directory, 'geosite.dat'), 'utf8')).toBe('previous')
    expect(await readdir(directory)).toEqual(['geosite.dat'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
