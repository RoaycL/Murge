import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detectShell } from '../src/renderer/src/platform/desktop-contract'
import { createDesktopApi } from '../src/renderer/src/platform/generated/desktop-api'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

describe('Tauri bridge runtime behavior', () => {
  beforeEach(() => invoke.mockClear())

  it('recognizes the first Tauri launch before the desktop bridge is installed', () => {
    expect(detectShell({ __TAURI_INTERNALS__: {} })).toEqual({ kind: 'tauri', hasDesktopBridge: false })
    expect(detectShell({ __TAURI_INTERNALS__: {}, desktop: {} })).toEqual({ kind: 'tauri', hasDesktopBridge: true })
    expect(detectShell({ desktop: {} })).toEqual({ kind: 'electron', hasDesktopBridge: true })
    expect(detectShell({})).toEqual({ kind: 'browser', hasDesktopBridge: false })
    expect(detectShell({ desktop: null })).toEqual({ kind: 'browser', hasDesktopBridge: false })
  })

  it('sends the user-selected backup password, WebDAV credentials and restore token unchanged', async () => {
    const api = createDesktopApi()
    const password = 'chosen-backup-password-秘密'
    const target = { url: 'https://example.com/archive.murge-backup', username: 'alice', password: 'webdav-secret' }
    await api.backup.create(password)
    await api.backup.webdavUpload(target, password)
    await api.backup.webdavPreview(target, password)
    await api.backup.restore('preview-token-123')
    expect(invoke.mock.calls).toEqual([
      ['desktop_ipc', { channel: 'backup:create', payload: [password] }],
      ['desktop_ipc', { channel: 'backup:webdav-upload', payload: [target, password] }],
      ['desktop_ipc', { channel: 'backup:webdav-preview', payload: [target, password] }],
      ['desktop_ipc', { channel: 'backup:restore', payload: ['preview-token-123'] }]
    ])
  })

  it('saves the WebDAV form with separate secrets and uses null for saved credentials', async () => {
    const api = createDesktopApi()
    const form = { address: 'https://dav.example.com/dav', filePath: 'App/app.murge-backup', url: 'https://dav.example.com/dav/App/app.murge-backup', username: 'alice', autoEnabled: true, intervalHours: 24 }
    const secrets = { password: 'webdav-secret', passphrase: null }
    const target = { url: form.url, username: 'alice', password: null }
    await api.backup.webdavSettings()
    await api.backup.webdavSave(form, secrets)
    await api.backup.webdavUpload(target, null)
    await api.backup.webdavForget()
    expect(invoke.mock.calls).toEqual([
      ['desktop_ipc', { channel: 'backup:webdav-settings', payload: [] }],
      ['desktop_ipc', { channel: 'backup:webdav-save', payload: [form, secrets] }],
      ['desktop_ipc', { channel: 'backup:webdav-upload', payload: [target, null] }],
      ['desktop_ipc', { channel: 'backup:webdav-forget', payload: [] }]
    ])
  })

  it('preserves positional values for every generated invoke method', async () => {
    let count = 0
    for (const [namespace, methods] of Object.entries(createDesktopApi())) {
      for (const [name, method] of Object.entries(methods)) {
        if (name.startsWith('on')) continue
        const callable = method as (...args: unknown[]) => Promise<unknown>
        const args = Array.from({ length: callable.length }, (_, index) => ({ namespace, name, index }))
        await callable(...args)
        expect(invoke.mock.lastCall?.[0]).toBe('desktop_ipc')
        expect(invoke.mock.lastCall?.[1].payload, `${namespace}.${name}`).toEqual(args)
        count++
      }
    }
    expect(count).toBe(159)
  })

  it('generates the identical bridge from Windows CRLF source files', async () => {
    const root = resolve(import.meta.dirname, '..')
    const temporary = await mkdtemp(resolve(tmpdir(), 'murge-bridge-crlf-'))
    const generated = 'src/renderer/src/platform/generated/desktop-api.ts'
    try {
      for (const path of ['scripts/generate-tauri-bridge.mjs', 'src/bridge/desktop-surface.ts', 'src/shared/ipc.ts']) {
        const content = await readFile(resolve(root, path), 'utf8')
        await mkdir(dirname(resolve(temporary, path)), { recursive: true })
        await writeFile(resolve(temporary, path), content.replace(/\r?\n/g, '\r\n'))
      }
      await promisify(execFile)(process.execPath, ['scripts/generate-tauri-bridge.mjs'], { cwd: temporary })
      expect(await readFile(resolve(temporary, generated), 'utf8')).toBe(await readFile(resolve(root, generated), 'utf8'))
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
