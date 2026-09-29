import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPendingConfigRestore, createConfigBackup, inspectConfigBackup, stageConfigRestore, type BackupSecretCodec } from '../src/main/backup/config-backup'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const codec: BackupSecretCodec = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => {
    const text = value.toString()
    if (!text.startsWith('encrypted:')) throw new Error('ciphertext invalid')
    return text.slice('encrypted:'.length)
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'murge-backup-test-'))
  roots.push(root)
  return root
}

describe('local configuration backup', () => {
  it('encrypts portable sources, previews contents, restores selected data and excludes caches', async () => {
    const source = await workspace()
    await mkdir(join(source, 'profiles', '.sources'), { recursive: true })
    await mkdir(join(source, 'substore', 'data'), { recursive: true })
    await mkdir(join(source, 'substore', 'assets'), { recursive: true })
    await mkdir(join(source, 'logs'), { recursive: true })
    await writeFile(join(source, 'app-settings.json'), '{"closeToTray":true}')
    await writeFile(join(source, 'profiles', 'id.yaml'), 'proxies: []')
    await writeFile(join(source, 'profiles', 'id.meta.json'), '{"id":"id"}')
    await writeFile(join(source, 'profiles', 'active.json'), 'id')
    await writeFile(join(source, 'profiles', '.sources', 'id.source.enc'), codec.encrypt('https://secret.example/sub?token=private'))
    await writeFile(join(source, 'substore', 'data', 'root.json'), '{"name":"SubStore"}')
    await writeFile(join(source, 'substore', 'data', 'sub-store.json'), '{"subscriptions":[]}')
    await writeFile(join(source, 'substore', 'assets', 'versions.json'), '{"asset":"excluded"}')
    await writeFile(join(source, 'logs', 'app-2026-09-29.log'), 'private log')
    const archive = await createConfigBackup(source, 'correct-password', '0.9.20', codec)
    expect(archive.toString()).not.toContain('secret.example')
    expect(archive.toString()).not.toContain('private log')
    expect(() => inspectConfigBackup(archive, 'wrong-password', '0.9.20')).toThrow()
    const { payload, preview } = inspectConfigBackup(archive, 'correct-password', '0.9.20')
    expect(preview).toMatchObject({ compatible: true, profileCount: 1, subscriptionSourceCount: 1, includesSubStore: true })
    expect(payload.files['logs/app-2026-09-29.log']).toBeUndefined()
    expect(payload.files['substore/data/root.json']).toBeDefined()
    expect(payload.files['substore/data/sub-store.json']).toBeDefined()
    expect(payload.files['substore/assets/versions.json']).toBeUndefined()
    const target = await workspace()
    await mkdir(join(target, 'profiles'), { recursive: true })
    await writeFile(join(target, 'app-settings.json'), '{"old":true}')
    await writeFile(join(target, 'profiles', 'obsolete.yaml'), 'old')
    await stageConfigRestore(target, payload, '0.9.20', codec)
    expect(await applyPendingConfigRestore(target)).toBe('restored')
    expect(await readFile(join(target, 'app-settings.json'), 'utf8')).toBe('{"closeToTray":true}')
    expect(await readFile(join(target, 'profiles', '.sources', 'id.source.enc')).then(codec.decrypt)).toContain('secret.example')
    expect(await readFile(join(target, 'substore', 'data', 'root.json'), 'utf8')).toBe('{"name":"SubStore"}')
    await expect(readFile(join(target, 'profiles', 'obsolete.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await applyPendingConfigRestore(target)).toBe('none')
  })

  it('blocks a backup from a newer application and rolls back an interrupted file apply', async () => {
    const source = await workspace()
    await writeFile(join(source, 'app-settings.json'), '{"new":true}')
    const archive = await createConfigBackup(source, 'correct-password', '0.10.0', codec)
    const { payload, preview } = inspectConfigBackup(archive, 'correct-password', '0.9.20')
    expect(preview.compatible).toBe(false)
    await expect(stageConfigRestore(await workspace(), payload, '0.9.20', codec)).rejects.toThrow('不兼容')
    const olderMinor = await createConfigBackup(source, 'correct-password', '0.8.9', codec)
    expect(inspectConfigBackup(olderMinor, 'correct-password', '0.9.20').preview.compatible).toBe(false)
    const currentArchive = await createConfigBackup(source, 'correct-password', '0.9.20', codec)
    const currentPayload = inspectConfigBackup(currentArchive, 'correct-password', '0.9.20').payload
    const target = await workspace()
    await writeFile(join(target, 'app-settings.json'), '{"old":true}')
    await stageConfigRestore(target, currentPayload, '0.9.20', codec)
    await rm(join(target, '.config-restore-pending', 'files', 'app-settings.json'))
    expect(await applyPendingConfigRestore(target)).toBe('rolled-back')
    expect(await readFile(join(target, 'app-settings.json'), 'utf8')).toBe('{"old":true}')
  })

  it('recovers the previous configuration after a simulated mid-restore crash', async () => {
    const source = await workspace()
    await writeFile(join(source, 'app-settings.json'), '{"new":true}')
    const archive = await createConfigBackup(source, 'correct-password', '0.9.20', codec)
    const payload = inspectConfigBackup(archive, 'correct-password', '0.9.20').payload
    const target = await workspace()
    await writeFile(join(target, 'app-settings.json'), '{"old":true}')
    await stageConfigRestore(target, payload, '0.9.20', codec)
    const pending = join(target, '.config-restore-pending')
    await mkdir(join(pending, 'rollback'), { recursive: true })
    await writeFile(join(pending, 'rollback', 'app-settings.json'), '{"old":true}')
    await writeFile(join(pending, 'rollback-index.json'), JSON.stringify(['app-settings.json']))
    await writeFile(join(pending, 'manifest.json'), JSON.stringify({ state: 'applying', files: ['app-settings.json'] }))
    await writeFile(join(target, 'app-settings.json'), '{"new":true}')
    expect(await applyPendingConfigRestore(target)).toBe('rolled-back')
    expect(await readFile(join(target, 'app-settings.json'), 'utf8')).toBe('{"old":true}')
  })
})
