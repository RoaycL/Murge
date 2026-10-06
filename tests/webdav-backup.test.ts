import { describe, expect, it, vi } from 'vitest'
import { downloadWebDavBackup, uploadWebDavBackup, validateWebDavTarget } from '../src/main/backup/webdav-backup'
import { MAX_ARCHIVE_BYTES } from '../src/main/backup/config-backup'

const target = { url: 'https://dav.example.com/backups/backup.murge-backup', username: 'alice', password: 'secret' }

describe('encrypted WebDAV backup transport', () => {
  it('only accepts explicit HTTPS backup-file URLs without embedded credentials', () => {
    expect(validateWebDavTarget(target).url).toBe(target.url)
    for (const url of [
      'http://dav.example.com/backup.murge-backup',
      'https://alice:secret@dav.example.com/backup.murge-backup',
      'https://dav.example.com/backup.murge-backup?token=secret',
      'https://dav.example.com/backups/'
    ]) expect(() => validateWebDavTarget({ ...target, url })).toThrow()
  })

  it('uploads only the supplied encrypted bytes and refuses redirects', async () => {
    const archive = Buffer.from('encrypted archive')
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('PUT')
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('alice:secret').toString('base64')}`)
      expect(Buffer.from(init?.body as Uint8Array)).toEqual(archive)
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    await uploadWebDavBackup(target, archive, fetchFn)
    expect(fetchFn).toHaveBeenCalledOnce()
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/file' } })) as unknown as typeof fetch
    await expect(uploadWebDavBackup(target, archive, redirect)).rejects.toThrow('重定向')
  })

  it('bounds downloads and never follows a remote redirect', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      return new Response('encrypted archive', { status: 200 })
    }) as unknown as typeof fetch
    expect(await downloadWebDavBackup(target, fetchFn)).toEqual(Buffer.from('encrypted archive'))
    const oversized = vi.fn(async () => new Response('x', { status: 200, headers: { 'content-length': String(MAX_ARCHIVE_BYTES + 1) } })) as unknown as typeof fetch
    await expect(downloadWebDavBackup(target, oversized)).rejects.toThrow('超过上限')
  })
})
