import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProtocolErrorCode } from '@shared/protocol-errors'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import {
  FileSystemProxyBackupStore,
  InMemorySystemProxyBackupStore,
  SYSTEM_PROXY_BACKUP_SCHEMA_VERSION,
  resolveSystemProxyBackupPath
} from '../src/main/system-proxy/backup-store'
import type {
  RegistryValue,
  SystemProxyBackup,
  SystemProxyRegistryState
} from '../src/main/system-proxy/types'

const dword = (value: number): RegistryValue => ({ exists: true, type: 'REG_DWORD', value })
const str = (value: string): RegistryValue => ({ exists: true, type: 'REG_SZ', value })

const previous: SystemProxyRegistryState = {
  proxyEnable: dword(0),
  proxyServer: { exists: false, type: 'none', value: null },
  proxyOverride: { exists: false, type: 'none', value: null }
}

const written: SystemProxyRegistryState = {
  proxyEnable: dword(1),
  proxyServer: str('http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7890'),
  proxyOverride: str('<local>;localhost;127.*;10.*;172.16.*;192.168.*')
}

function makeBackup(): SystemProxyBackup {
  return {
    schemaVersion: SYSTEM_PROXY_BACKUP_SCHEMA_VERSION,
    instanceId: 'test-instance',
    createdAt: '2024-01-01T00:00:00.000Z',
    target: { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 },
    previous,
    written
  }
}

describe('resolveSystemProxyBackupPath', () => {
  it('places the backup under an app-data base', () => {
    expect(resolveSystemProxyBackupPath('/app/data')).toBe('/app/data/system-proxy/owned-backup.json')
  })
})

describe('FileSystemProxyBackupStore', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  async function freshStore(): Promise<{ store: FileSystemProxyBackupStore; file: string }> {
    tempDir = await mkdtemp(join(tmpdir(), 'murge-sysproxy-'))
    const file = join(tempDir, 'owned-backup.json')
    return { store: new FileSystemProxyBackupStore(file), file }
  }

  it('returns null when no backup exists', async () => {
    const { store } = await freshStore()
    await expect(store.read()).resolves.toBeNull()
  })

  it('writes and reads back an intact backup', async () => {
    const { store } = await freshStore()
    const backup = makeBackup()
    await store.write(backup)
    const read = await store.read()
    expect(read).toEqual(backup)
  })

  it('writes valid JSON with a trailing newline', async () => {
    const { store, file } = await freshStore()
    await store.write(makeBackup())
    const raw = await readFile(file, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual(makeBackup())
  })

  it('delete removes the backup and makes read return null', async () => {
    const { store } = await freshStore()
    await store.write(makeBackup())
    await store.delete()
    await expect(store.read()).resolves.toBeNull()
  })

  it('delete is idempotent (no-op when already absent)', async () => {
    const { store } = await freshStore()
    await expect(store.delete()).resolves.toBeUndefined()
  })

  it('throws RESTORE_FAILED on a corrupt JSON payload', async () => {
    const { store, file } = await freshStore()
    await store.write(makeBackup())
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, '{not-json', 'utf8'))
    await expect(store.read()).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED })
  })

  it('throws RESTORE_FAILED on a schema-mismatched payload', async () => {
    const { store, file } = await freshStore()
    await store.write(makeBackup())
    const bad = { ...makeBackup(), schemaVersion: 999 }
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(bad), 'utf8'))
    await expect(store.read()).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED })
  })

  it('throws RESTORE_FAILED on a malformed (non-backup) payload', async () => {
    const { store, file } = await freshStore()
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify({ hello: 'world' }), 'utf8'))
    await expect(store.read()).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED })
  })

  it('round-trips via forAppDataBase', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'murge-sysproxy-'))
    const store = FileSystemProxyBackupStore.forAppDataBase(tempDir)
    await store.write(makeBackup())
    await expect(store.read()).resolves.toEqual(makeBackup())
  })

  it('rejects a backup whose target host is not the loopback host', async () => {
    const { store, file } = await freshStore()
    await store.write(makeBackup())
    const bad = { ...makeBackup(), target: { host: '0.0.0.0', port: 7890 } }
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(bad), 'utf8'))
    await expect(store.read()).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED })
  })

  it('rejects a backup with an out-of-range port', async () => {
    const { store, file } = await freshStore()
    await store.write(makeBackup())
    const bad = { ...makeBackup(), target: { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 0 } }
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(bad), 'utf8'))
    await expect(store.read()).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED })
  })

  it('rejects a backup with an internally inconsistent registry value', async () => {
    const { store, file } = await freshStore()
    await store.write(makeBackup())
    const bad = {
      ...makeBackup(),
      previous: { ...previous, proxyServer: { exists: true, type: 'REG_SZ', value: null } }
    }
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(bad), 'utf8'))
    await expect(store.read()).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED })
  })

  it('rejects a backup whose schemaVersion is not the exact literal', async () => {
    const { store, file } = await freshStore()
    await store.write(makeBackup())
    const bad = { ...makeBackup(), schemaVersion: '1' }
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(bad), 'utf8'))
    await expect(store.read()).rejects.toMatchObject({ code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED })
  })

  it('round-trips a REG_EXPAND_SZ / REG_BINARY pair without collapsing the type', async () => {
    const { store, file } = await freshStore()
    const expandPrevious: SystemProxyRegistryState = {
      proxyEnable: dword(0),
      proxyServer: { exists: true, type: 'REG_EXPAND_SZ', value: '%PROGRAMFILES%\\proxy' },
      proxyOverride: { exists: true, type: 'REG_BINARY', value: 'DEADBEEF' }
    }
    const backup = { ...makeBackup(), previous: expandPrevious }
    await store.write(backup)
    await expect(store.read()).resolves.toEqual(backup)
    const raw = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(file, 'utf8')))
    expect(raw.previous.proxyServer.type).toBe('REG_EXPAND_SZ')
    expect(raw.previous.proxyOverride.type).toBe('REG_BINARY')
  })
})

describe('InMemorySystemProxyBackupStore', () => {
  it('preserves the first backup until deleted (one-backup-at-a-time)', async () => {
    const store = new InMemorySystemProxyBackupStore()
    const first = makeBackup()
    const second = { ...makeBackup(), instanceId: 'other' }
    await store.write(first)
    await store.write(second)
    await expect(store.read()).resolves.toEqual(first)
    await store.delete()
    await expect(store.read()).resolves.toBeNull()
    await store.write(second)
    await expect(store.read()).resolves.toEqual(second)
  })

  it('starts empty', async () => {
    const store = new InMemorySystemProxyBackupStore()
    await expect(store.read()).resolves.toBeNull()
  })
})
