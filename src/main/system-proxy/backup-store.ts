import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import { SYSTEM_PROXY_BACKUP_SCHEMA_VERSION, systemProxyBackupSchema } from './backup-schema'
import type { SystemProxyBackup, SystemProxyBackupStore } from './types'

export { SYSTEM_PROXY_BACKUP_SCHEMA_VERSION } from './backup-schema'

export const SYSTEM_PROXY_BACKUP_SUBDIR = 'system-proxy'
export const SYSTEM_PROXY_BACKUP_FILE = 'owned-backup.json'

/** Resolve the owned-backup file path under a brand-independent app-data base. */
export function resolveSystemProxyBackupPath(appDataBase: string): string {
  return join(appDataBase, SYSTEM_PROXY_BACKUP_SUBDIR, SYSTEM_PROXY_BACKUP_FILE)
}

/**
 * File-backed owned-backup store.
 *
 * Writes are atomic (temp file in the same directory, then rename) so a crash
 * mid-write can never leave a half-written JSON payload that the next launch
 * would mistake for a valid backup. A malformed or schema-mismatched backup is
 * treated as a hard, non-recoverable condition and surfaced to the caller.
 */
export class FileSystemProxyBackupStore implements SystemProxyBackupStore {
  constructor(private readonly filePath: string) {}

  static forAppDataBase(appDataBase: string): FileSystemProxyBackupStore {
    return new FileSystemProxyBackupStore(resolveSystemProxyBackupPath(appDataBase))
  }

  async read(): Promise<SystemProxyBackup | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      // A backup that exists but cannot be read is not something we can silently
      // ignore — surfacing an error stops us from guessing what to write back.
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '无法读取系统代理备份文件')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '系统代理备份文件已损坏')
    }
    const validated = systemProxyBackupSchema.safeParse(parsed)
    if (!validated.success) {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '系统代理备份文件格式无效')
    }
    return validated.data
  }

  async write(backup: SystemProxyBackup): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = join(dirname(this.filePath), `.${SYSTEM_PROXY_BACKUP_FILE}.${randomUUID()}.tmp`)
    const payload = JSON.stringify(backup, null, 2) + '\n'
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, this.filePath)
  }

  async delete(): Promise<void> {
    try {
      await unlink(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * In-memory backup store used by the dev build (so the dev process never writes
 * a backup into real user data) and available to unit tests. It mirrors the
 * file-backed store's semantics exactly: `write` REPLACES the current value, so
 * a later `enable`/`setProxyBypass` supersedes an older bundle rather than being
 * silently dropped (the previous no-op-when-present behaviour diverged from the
 * file store, where a write is an overwrite).
 */
export class InMemorySystemProxyBackupStore implements SystemProxyBackupStore {
  private value: SystemProxyBackup | null = null

  async read(): Promise<SystemProxyBackup | null> {
    return this.value
  }

  async write(backup: SystemProxyBackup): Promise<void> {
    this.value = backup
  }

  async delete(): Promise<void> {
    this.value = null
  }
}
