import { describe, expect, it } from 'vitest'
import { composeWebDavFileUrl, defaultWebDavFilePath } from '../src/shared/webdav-backup'

const DEFAULT = defaultWebDavFilePath('Demo App')

describe('composeWebDavFileUrl', () => {
  it('derives the default path from the product name', () => {
    expect(DEFAULT).toBe('Demo App/demo-app.murge-backup')
    expect(defaultWebDavFilePath('')).toBe('backup/backup.murge-backup')
  })

  it('joins server address and file path into one .murge-backup URL', () => {
    expect(composeWebDavFileUrl('https://dav.example.com', DEFAULT))
      .toBe('https://dav.example.com/Demo%20App/demo-app.murge-backup')
    expect(composeWebDavFileUrl(' https://dav.example.com/dav/ ', '/backups/home.murge-backup'))
      .toBe('https://dav.example.com/dav/backups/home.murge-backup')
  })

  it('fills in the default name and extension', () => {
    expect(composeWebDavFileUrl('https://dav.example.com', '', DEFAULT)).toBe('https://dav.example.com/Demo%20App/demo-app.murge-backup')
    expect(composeWebDavFileUrl('https://dav.example.com', 'Demo/', DEFAULT)).toBe('https://dav.example.com/Demo/demo-app.murge-backup')
    expect(composeWebDavFileUrl('https://dav.example.com', 'Demo\\home')).toBe('https://dav.example.com/Demo/home.murge-backup')
  })

  it('encodes path segments so they cannot inject a query or fragment', () => {
    expect(composeWebDavFileUrl('https://dav.example.com', '我的 备份/a?b#c'))
      .toBe('https://dav.example.com/%E6%88%91%E7%9A%84%20%E5%A4%87%E4%BB%BD/a%3Fb%23c.murge-backup')
    expect(composeWebDavFileUrl('https://dav.example.com', 'a%20b')).toBe('https://dav.example.com/a%20b.murge-backup')
  })

  it('keeps a full file URL pasted into the address and returns empty without an address', () => {
    expect(composeWebDavFileUrl('https://dav.example.com/x/old.murge-backup', 'ignored'))
      .toBe('https://dav.example.com/x/old.murge-backup')
    expect(composeWebDavFileUrl('  ', 'x/a')).toBe('')
  })
})
