import { describe, expect, it } from 'vitest'
import { composeWebDavFileUrl, WEBDAV_DEFAULT_FILE_PATH } from '../src/shared/webdav-backup'

describe('composeWebDavFileUrl', () => {
  it('joins server address and file path into one .murge-backup URL', () => {
    expect(composeWebDavFileUrl('https://dav.example.com', WEBDAV_DEFAULT_FILE_PATH))
      .toBe('https://dav.example.com/Murge/murge.murge-backup')
    expect(composeWebDavFileUrl(' https://dav.example.com/dav/ ', '/backups/home.murge-backup'))
      .toBe('https://dav.example.com/dav/backups/home.murge-backup')
  })

  it('fills in the default name and extension', () => {
    expect(composeWebDavFileUrl('https://dav.example.com', '')).toBe('https://dav.example.com/Murge/murge.murge-backup')
    expect(composeWebDavFileUrl('https://dav.example.com', 'Murge/')).toBe('https://dav.example.com/Murge/murge.murge-backup')
    expect(composeWebDavFileUrl('https://dav.example.com', 'Murge\\home')).toBe('https://dav.example.com/Murge/home.murge-backup')
  })

  it('encodes path segments so they cannot inject a query or fragment', () => {
    expect(composeWebDavFileUrl('https://dav.example.com', '我的 备份/a?b#c'))
      .toBe('https://dav.example.com/%E6%88%91%E7%9A%84%20%E5%A4%87%E4%BB%BD/a%3Fb%23c.murge-backup')
    expect(composeWebDavFileUrl('https://dav.example.com', 'a%20b')).toBe('https://dav.example.com/a%20b.murge-backup')
  })

  it('keeps a full file URL pasted into the address and returns empty without an address', () => {
    expect(composeWebDavFileUrl('https://dav.example.com/x/old.murge-backup', 'ignored'))
      .toBe('https://dav.example.com/x/old.murge-backup')
    expect(composeWebDavFileUrl('  ', 'Murge/a')).toBe('')
  })
})
