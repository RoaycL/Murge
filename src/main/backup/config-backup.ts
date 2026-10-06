import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brand } from '../../shared/brand'
import type { ConfigBackupPreview } from '../../shared/config-backup'

const FORMAT = 'murge-config-backup'
const SCHEMA_VERSION = 1
// A single profile may be as large as a subscription download (16 MiB, see
// subscription-fetcher.ts). Files travel base64-encoded inside a payload that
// is itself base64-encoded in the archive (about 16/9 of the content), so the
// archive cap is sized to hold a full MAX_CONTENT_BYTES backup.
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_CONTENT_BYTES = 32 * 1024 * 1024
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_FILES = 500
const PENDING_DIR = '.config-restore-pending'
const ROOT_FILES = new Set([
  'app-settings.json', 'core-settings.json', 'dns-enhancement.json', 'sniffer-enhancement.json',
  'tun-config.json', 'geodata-settings.json', 'overrides.json', 'proxy-selections.json',
  'proxy-bypass-policy.json'
])

export interface BackupSecretCodec {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export interface ConfigBackupPayload {
  appId: string
  appVersion: string
  createdAt: string
  files: Record<string, string>
  sourceUrls: Record<string, string>
}

function isBackupPath(path: string): boolean {
  if (ROOT_FILES.has(path)) return true
  if (/^profiles\/(?:active\.json|[A-Za-z0-9_-]+\.(?:yaml|meta\.json))$/.test(path)) return true
  if (!path.startsWith('substore/data/')) return false
  const parts = path.split('/').slice(2)
  return parts.length >= 1 && parts.length <= 6 && parts.every((part) => part.length > 0 && part.length <= 128 && part !== '.' && part !== '..' && !/[\\/:\0-\x1f]/.test(part))
}

async function readDirOrEmpty(path: string): Promise<import('node:fs').Dirent[]> {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function assertSafeManagedTarget(root: string, relative: string): Promise<void> {
  let current = root
  for (const part of relative.split('/')) {
    current = join(current, part)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isSymbolicLink()) throw new Error('配置目录包含符号链接，已阻止备份或恢复')
  }
}

async function listManagedFiles(root: string): Promise<string[]> {
  const paths: string[] = []
  const add = async (relative: string): Promise<void> => {
    await assertSafeManagedTarget(root, relative)
    const info = await lstat(join(root, ...relative.split('/'))).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isFile() && !info.isSymbolicLink()) paths.push(relative)
  }
  for (const name of ROOT_FILES) await add(name)
  const profiles = await readDirOrEmpty(join(root, 'profiles'))
  for (const entry of profiles) {
    if (entry.isFile() && isBackupPath(`profiles/${entry.name}`)) await add(`profiles/${entry.name}`)
  }
  await add('substore/root.json')
  await add('substore/sub-store.json')
  const walkSubStore = async (relative: string, depth: number): Promise<void> => {
    if (depth > 6) return
    const entries = await readDirOrEmpty(join(root, ...relative.split('/')))
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`
      if (!isBackupPath(child) && !entry.isDirectory()) continue
      if (entry.isDirectory() && entry.name !== '.' && entry.name !== '..' && entry.name.length <= 128 && !/[\\/:\0-\x1f]/.test(entry.name)) await walkSubStore(child, depth + 1)
      else if (entry.isFile() && isBackupPath(child)) await add(child)
    }
  }
  await walkSubStore('substore/data', 0)
  if (paths.length > MAX_FILES) throw new Error('配置文件数量超过备份上限')
  return paths.sort()
}

function requirePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new Error('备份密码需要 8 至 256 个字符')
  }
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('备份文件内容无效')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw new Error('备份文件内容无效')
  return decoded
}

function parseVersion(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compatibility(backupVersion: string, currentVersion: string): { compatible: boolean; message: string } {
  const source = parseVersion(backupVersion)
  const current = parseVersion(currentVersion)
  if (!source || !current) return { compatible: false, message: '无法识别版本号，已阻止恢复' }
  if (source[0] !== current[0]) return { compatible: false, message: '主版本不同，已阻止恢复' }
  if (source[0] === 0 && source[1] !== current[1]) return { compatible: false, message: '0.x 版本的次版本不同，无法安全恢复' }
  for (let index = 0; index < 3; index++) {
    if (source[index] > current[index]) return { compatible: false, message: '备份来自更新的应用版本，请先升级应用' }
    if (source[index] < current[index]) break
  }
  return { compatible: true, message: source.join('.') === current.join('.') ? '版本一致' : '旧版本备份，恢复后将按当前版本读取' }
}

function validatePayload(value: unknown): ConfigBackupPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份内容格式无效')
  const data = value as Record<string, unknown>
  if (data.appId !== brand.appId || typeof data.appVersion !== 'string' ||
      typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) throw new Error('备份来源或版本无效')
  if (!data.files || typeof data.files !== 'object' || Array.isArray(data.files) ||
      !data.sourceUrls || typeof data.sourceUrls !== 'object' || Array.isArray(data.sourceUrls)) throw new Error('备份内容格式无效')
  const files = data.files as Record<string, unknown>
  const sourceUrls = data.sourceUrls as Record<string, unknown>
  if (Object.keys(files).length > MAX_FILES) throw new Error('备份文件数量超过上限')
  let total = 0
  for (const [path, content] of Object.entries(files)) {
    if (!isBackupPath(path)) throw new Error('备份包含不允许的路径')
    const bytes = decodeBase64(content)
    if (bytes.length > MAX_FILE_BYTES) throw new Error('单个配置文件超过上限')
    total += bytes.length
  }
  if (total > MAX_CONTENT_BYTES) throw new Error('备份内容超过上限')
  if (Object.keys(sourceUrls).length > MAX_FILES) throw new Error('订阅来源数量超过上限')
  for (const [id, url] of Object.entries(sourceUrls)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || typeof url !== 'string' || url.length > 16384) throw new Error('订阅来源内容无效')
  }
  return data as unknown as ConfigBackupPayload
}

/** Local archive contains portable subscription sources, encrypted as one AES-GCM payload. */
export async function createConfigBackup(root: string, password: string, version: string, codec: BackupSecretCodec): Promise<Buffer> {
  requirePassword(password)
  const files: Record<string, string> = {}
  let total = 0
  for (const path of await listManagedFiles(root)) {
    const content = await readFile(join(root, ...path.split('/')))
    if (content.length > MAX_FILE_BYTES) throw new Error(`配置文件 ${path} 超过备份上限`)
    total += content.length
    if (total > MAX_CONTENT_BYTES) throw new Error('备份内容超过上限')
    files[path] = content.toString('base64')
  }
  const sourceUrls: Record<string, string> = {}
  const sourceDir = join(root, 'profiles', '.sources')
  await assertSafeManagedTarget(root, 'profiles/.sources')
  const entries = await readDirOrEmpty(sourceDir)
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.source\.enc$/.test(entry.name)) continue
    await assertSafeManagedTarget(root, `profiles/.sources/${entry.name}`)
    if (!codec.isAvailable()) throw new Error('系统安全存储不可用，无法备份订阅地址')
    const id = entry.name.slice(0, -'.source.enc'.length)
    sourceUrls[id] = codec.decrypt(await readFile(join(sourceDir, entry.name)))
  }
  const payload: ConfigBackupPayload = { appId: brand.appId, appVersion: version, createdAt: new Date().toISOString(), files, sourceUrls }
  validatePayload(payload)
  const plaintext = Buffer.from(JSON.stringify(payload))
  if (plaintext.length > MAX_CONTENT_BYTES * 2) throw new Error('备份内容超过上限')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const archive = Buffer.from(JSON.stringify({ format: FORMAT, schemaVersion: SCHEMA_VERSION, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }))
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('备份文件超过上限')
  return archive
}

export function inspectConfigBackup(archive: Buffer, password: string, currentVersion: string): { payload: ConfigBackupPayload; preview: Omit<ConfigBackupPreview, 'token' | 'replaceCount' | 'addCount' | 'removeCount'> } {
  requirePassword(password)
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('备份文件超过上限')
  let envelope: Record<string, unknown>
  try { envelope = JSON.parse(archive.toString('utf8')) as Record<string, unknown> }
  catch { throw new Error('备份文件格式无效') }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('备份文件格式无效')
  if (envelope.format !== FORMAT || envelope.schemaVersion !== SCHEMA_VERSION || envelope.kdf !== 'scrypt') throw new Error('备份格式版本不兼容')
  const salt = decodeBase64(envelope.salt)
  const iv = decodeBase64(envelope.iv)
  const tag = decodeBase64(envelope.tag)
  const ciphertext = decodeBase64(envelope.ciphertext)
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('备份加密参数无效')
  let payload: ConfigBackupPayload
  try {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv)
    decipher.setAuthTag(tag)
    payload = validatePayload(JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')))
  } catch { throw new Error('密码错误或备份文件已损坏') }
  const version = compatibility(payload.appVersion, currentVersion)
  return {
    payload,
    preview: {
      createdAt: payload.createdAt, appVersion: payload.appVersion,
      compatible: version.compatible, compatibilityMessage: version.message,
      profileCount: Object.keys(payload.files).filter((path) => /^profiles\/[^/]+\.meta\.json$/.test(path)).length,
      subscriptionSourceCount: Object.keys(payload.sourceUrls).length,
      includesOverrides: 'overrides.json' in payload.files,
      includesSubStore: Object.keys(payload.files).some((path) => path.startsWith('substore/')),
      fileCount: Object.keys(payload.files).length
    }
  }
}

function pendingPath(root: string): string { return join(root, PENDING_DIR) }

/** Stage and re-encrypt portable sources for this Windows account; startup applies the files. */
export async function stageConfigRestore(root: string, payload: ConfigBackupPayload, currentVersion: string, codec: BackupSecretCodec): Promise<void> {
  validatePayload(payload)
  if (!compatibility(payload.appVersion, currentVersion).compatible) throw new Error('备份版本与当前应用不兼容')
  const pending = pendingPath(root)
  if (await lstat(pending).then(() => true).catch(() => false)) throw new Error('已有待恢复备份，请先重启应用')
  const stage = join(root, `.config-restore-stage-${randomUUID()}`)
  const files: Record<string, Buffer> = {}
  for (const [path, content] of Object.entries(payload.files)) files[path] = decodeBase64(content)
  if (Object.keys(payload.sourceUrls).length && !codec.isAvailable()) throw new Error('系统安全存储不可用，无法恢复订阅地址')
  for (const [id, url] of Object.entries(payload.sourceUrls)) files[`profiles/.sources/${id}.source.enc`] = codec.encrypt(url)
  for (const path of Object.keys(files)) await assertSafeManagedTarget(root, path)
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(stage, 'files', ...path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, { mode: 0o600 })
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ state: 'prepared', files: Object.keys(files) }), { mode: 0o600 })
    await rename(stage, pending)
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function describeConfigRestoreImpact(root: string, payload: ConfigBackupPayload): Promise<Pick<ConfigBackupPreview, 'replaceCount' | 'addCount' | 'removeCount'>> {
  const current = new Set(await listCurrentRestorePaths(root))
  const incoming = new Set([
    ...Object.keys(payload.files),
    ...Object.keys(payload.sourceUrls).map((id) => `profiles/.sources/${id}.source.enc`)
  ])
  return {
    replaceCount: [...incoming].filter((path) => current.has(path)).length,
    addCount: [...incoming].filter((path) => !current.has(path)).length,
    removeCount: [...current].filter((path) => !incoming.has(path)).length
  }
}

function isRestorePath(path: string): boolean {
  return isBackupPath(path) || /^profiles\/\.sources\/[A-Za-z0-9_-]+\.source\.enc$/.test(path)
}

async function listCurrentRestorePaths(root: string): Promise<string[]> {
  const files = await listManagedFiles(root)
  const entries = await readDirOrEmpty(join(root, 'profiles', '.sources'))
  const sources = entries.filter((entry) => entry.isFile() && /^[A-Za-z0-9_-]+\.source\.enc$/.test(entry.name)).map((entry) => `profiles/.sources/${entry.name}`)
  for (const path of sources) await assertSafeManagedTarget(root, path)
  return [...files, ...sources]
}

/** Called before any settings/profile service reads; interrupted applies roll back on next launch. */
export async function applyPendingConfigRestore(root: string): Promise<'none' | 'restored' | 'rolled-back'> {
  const pending = pendingPath(root)
  const raw = await readFile(join(pending, 'manifest.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return 'none'
  const manifest = JSON.parse(raw) as { state: string; files: string[] }
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_FILES + 500 || !manifest.files.every((path) => typeof path === 'string' && isRestorePath(path))) throw new Error('待恢复文件清单无效')
  for (const path of manifest.files) await assertSafeManagedTarget(root, path)
  const rollbackIndex = join(pending, 'rollback-index.json')
  const rollback = async (): Promise<void> => {
    const previous = JSON.parse(await readFile(rollbackIndex, 'utf8')) as string[]
    if (!Array.isArray(previous) || !previous.every((path) => typeof path === 'string' && isRestorePath(path))) throw new Error('回滚清单无效')
    for (const path of new Set([...previous, ...manifest.files])) {
      const target = join(root, ...path.split('/'))
      if (previous.includes(path)) {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(join(pending, 'rollback', ...path.split('/')), target)
      } else await rm(target, { force: true })
    }
  }
  if (manifest.state === 'applying') {
    await rollback()
    await rm(pending, { recursive: true, force: true })
    return 'rolled-back'
  }
  if (manifest.state === 'done') {
    await rm(pending, { recursive: true, force: true })
    return 'restored'
  }
  if (manifest.state !== 'prepared') throw new Error('待恢复状态无效')
  const current = await listCurrentRestorePaths(root)
  for (const path of current) {
    const target = join(pending, 'rollback', ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(root, ...path.split('/')), target)
  }
  await writeFile(rollbackIndex, JSON.stringify(current), { mode: 0o600 })
  await writeFile(join(pending, 'manifest-next.json'), JSON.stringify({ state: 'applying', files: manifest.files }), { mode: 0o600 })
  await rename(join(pending, 'manifest-next.json'), join(pending, 'manifest.json'))
  try {
    for (const path of current) if (!manifest.files.includes(path)) await rm(join(root, ...path.split('/')), { force: true })
    for (const path of manifest.files) {
      const target = join(root, ...path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(pending, 'files', ...path.split('/')), target)
    }
  } catch (error) {
    await rollback()
    await rm(pending, { recursive: true, force: true })
    console.error('[config-backup] restore failed; previous configuration recovered:', error)
    return 'rolled-back'
  }
  await writeFile(join(pending, 'manifest-next.json'), JSON.stringify({ state: 'done', files: manifest.files }), { mode: 0o600 })
  await rename(join(pending, 'manifest-next.json'), join(pending, 'manifest.json'))
  await rm(pending, { recursive: true, force: true }).catch(() => undefined)
  return 'restored'
}
