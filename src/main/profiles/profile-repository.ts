import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { ConfigEdit, Profile, ProfileMeta, ProfileSubscription } from '../../shared/profiles'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { ConfigValidator } from './config-validator'

/**
 * Manages a single, isolated profile directory.
 *
 * Reads and writes are restricted to a configured root so an imported document
 * can never escape into arbitrary paths. Every write is atomic (temp file +
 * rename), so a crash mid-write leaves either the old or the new content — never
 * a torn file. The raw YAML is stored verbatim; edits are applied as surgical
 * text replacements so unsupported keys and comments survive.
 */

const DOC_EXTENSION = '.yaml'
const META_EXTENSION = '.meta.json'
const ACTIVE_FILE = 'active.json'

export interface ProfileRepositoryOptions {
  /** Absolute path to the isolated profile directory. */
  rootDir: string
  validator: ConfigValidator
  idGenerator?: () => string
  /** Clock for timestamps (ms); injectable for deterministic tests. */
  now?: () => number
}

function assertInsideRoot(rootDir: string, target: string): void {
  const root = resolve(rootDir) + sep
  const resolved = resolve(target)
  if (!(resolved === resolve(rootDir) || resolved.startsWith(root))) {
    throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'path escapes the profile directory')
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** Find the index where an inline YAML `#` comment begins, or -1. */
function findCommentIndex(valueText: string): number {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < valueText.length; i += 1) {
    const char = valueText[i]
    if (char === "'" && !inDouble) inSingle = !inSingle
    else if (char === '"' && !inSingle) inDouble = !inDouble
    else if (char === '#' && !inSingle && !inDouble && (i === 0 || valueText[i - 1] === ' ' || valueText[i - 1] === '\t')) {
      return i
    }
  }
  return -1
}

export class ProfileRepository {
  private readonly idGenerator: () => string
  private readonly now: () => number

  constructor(private readonly options: ProfileRepositoryOptions) {
    this.idGenerator = options.idGenerator ?? (() => randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private docPath(id: string): string {
    const path = join(this.options.rootDir, `${sanitizeId(id)}${DOC_EXTENSION}`)
    assertInsideRoot(this.options.rootDir, path)
    return path
  }

  private metaPath(id: string): string {
    const path = join(this.options.rootDir, `${sanitizeId(id)}${META_EXTENSION}`)
    assertInsideRoot(this.options.rootDir, path)
    return path
  }

  private activePath(): string {
    const path = join(this.options.rootDir, ACTIVE_FILE)
    assertInsideRoot(this.options.rootDir, path)
    return path
  }

  private async readActive(): Promise<string | null> {
    try {
      const raw = (await readFile(this.activePath(), 'utf8')).trim()
      if (!raw) return null
      return raw
    } catch {
      return null
    }
  }

  private async writeBytes(path: string, content: string | Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temp = join(this.options.rootDir, `.tmp-${Date.now()}-${randomUUID()}`)
    assertInsideRoot(this.options.rootDir, temp)
    await writeFile(temp, content)
    await rename(temp, path)
  }

  private async writeActive(id: string | null): Promise<void> {
    await this.writeBytes(this.activePath(), id ?? '')
  }

  /** Generate a fresh identifier not already present on disk. */
  async createId(): Promise<string> {
    for (;;) {
      const id = this.idGenerator()
      try {
        await readFile(this.metaPath(id), 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return id
      }
    }
  }

  async list(): Promise<ProfileMeta[]> {
    await mkdir(this.options.rootDir, { recursive: true })
    const activeId = await this.readActive()
    const entries = await readdir(this.options.rootDir)
    const metas: ProfileMeta[] = []
    for (const name of entries) {
      if (!name.endsWith(META_EXTENSION)) continue
      const id = name.slice(0, -META_EXTENSION.length)
      try {
        const meta = JSON.parse(await readFile(this.metaPath(id), 'utf8')) as ProfileMeta
        metas.push({ ...meta, active: meta.id === activeId })
      } catch {
        // Skip a torn/unreadable meta file rather than failing the whole list.
      }
    }
    return metas.sort((a, b) => a.createdAt - b.createdAt)
  }

  async get(id: string): Promise<Profile> {
    const metaPath = this.metaPath(id)
    const docPath = this.docPath(id)
    let meta: ProfileMeta
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8')) as ProfileMeta
    } catch {
      throw new ProtocolError(ProtocolErrorCode.NOT_FOUND, `profile ${id} not found`)
    }
    const document = await readFile(docPath, 'utf8')
    const activeId = await this.readActive()
    return { meta: { ...meta, active: meta.id === activeId }, document }
  }

  private async ensureUniqueName(name: string, excludeId?: string): Promise<void> {
    const existing = await this.list()
    const normalized = normalizeName(name)
    const duplicate = existing.find((meta) => meta.id !== excludeId && normalizeName(meta.name) === normalized)
    if (duplicate) {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_ARGUMENT,
        `a profile named "${name}" already exists`
      )
    }
  }

  /**
   * Persist a new profile. The document is written first, then its metadata, so
   * a partially-imported profile is never listed as a valid profile.
   */
  async import(name: string, document: string, source: ProfileSubscription, activate: boolean): Promise<ProfileMeta> {
    await mkdir(this.options.rootDir, { recursive: true })
    await this.ensureUniqueName(name)
    const id = await this.createId()
    const timestamp = this.now()
    const meta: ProfileMeta = {
      id,
      name: name.trim(),
      source,
      size: Buffer.byteLength(document, 'utf8'),
      createdAt: timestamp,
      updatedAt: timestamp,
      active: false
    }
    // Commit order: document, then meta, then (optionally) activation pointer.
    await this.writeBytes(this.docPath(id), document)
    await this.writeBytes(this.metaPath(id), JSON.stringify(meta))
    if (activate) {
      await this.writeActive(id)
      return { ...meta, active: true }
    }
    return meta
  }

  async activate(id: string): Promise<ProfileMeta> {
    const meta = await this.get(id)
    await this.writeActive(id)
    return { ...meta.meta, active: true }
  }

  async delete(id: string): Promise<void> {
    const activeId = await this.readActive()
    await rm(this.docPath(id), { force: true })
    await rm(this.metaPath(id), { force: true })
    // If the deleted profile was active, clear the pointer so the app does not
    // reference a missing profile.
    if (activeId === id) await this.writeActive(null)
  }

  async rename(id: string, name: string): Promise<ProfileMeta> {
    await this.ensureUniqueName(name, id)
    const profile = await this.get(id)
    const updated: ProfileMeta = { ...profile.meta, name: name.trim(), updatedAt: this.now() }
    await this.writeBytes(this.metaPath(id), JSON.stringify(updated))
    return updated
  }

  /**
   * Return the document that {@link editDocument} would write WITHOUT persisting
   * it. Lets the service validate the result before it ever reaches disk, so a
   * rejected edit never leaves a half-edited document behind.
   */
  async previewEdit(id: string, edits: ConfigEdit[]): Promise<string> {
    const profile = await this.get(id)
    return applyEdits(profile.document, edits)
  }

  /**
   * Apply supported scalar edits without re-serializing the document. Only the
   * value of each listed top-level key changes; unknown keys, their order, and
   * any inline or standalone comments are preserved verbatim.
   */
  async editDocument(id: string, edits: ConfigEdit[]): Promise<ProfileMeta> {
    const profile = await this.get(id)
    const updatedDocument = applyEdits(profile.document, edits)
    await this.writeBytes(this.docPath(id), updatedDocument)
    const updated: ProfileMeta = { ...profile.meta, updatedAt: this.now() }
    await this.writeBytes(this.metaPath(id), JSON.stringify(updated))
    return updated
  }
}

/** Replace `<key>: <value>` scalar lines at the top level, preserving the rest. */
export function applyEdits(document: string, edits: ConfigEdit[]): string {
  let output = document
  for (const edit of edits) {
    output = replaceScalar(output, edit.key, edit.value)
  }
  return output
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceScalar(document: string, key: string, value: string): string {
  const lines = document.split('\n')
  const pattern = new RegExp(`^(\\s*)(${escapeRegExp(key)}):(\\s*)(.*)$`)
  let startIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].match(pattern)) {
      // Only treat it as top-level when it is not indented (column 1).
      const indent = lines[i].match(pattern)![1] as string
      if (indent.length === 0) {
        startIndex = i
        break
      }
    }
  }
  if (startIndex === -1) {
    // Insert the new key after the first top-level mapping line, or append.
    return insertKey(document, key, value)
  }
  const match = lines[startIndex].match(pattern)!
  const valueText = match[4] as string
  const commentIndex = findCommentIndex(valueText)
  const comment = commentIndex === -1 ? '' : valueText.slice(commentIndex)
  const replacement = `${key}: ${value}${comment === '' ? '' : ` ${comment.trimStart()}`}`
  lines[startIndex] = replacement
  return lines.join('\n')
}

function insertKey(document: string, key: string, value: string): string {
  const lines = document.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    // Stop at the first non-comment, non-empty top-level mapping line.
    if (trimmed !== '' && !trimmed.startsWith('#') && /^[A-Za-z0-9_.-]+\s*:/.test(trimmed)) {
      const indent = line.match(/^(\s*)/)![1] as string
      const marker = `${indent}# Added by ${key} setting`
      lines.splice(i, 0, marker, `${indent}${key}: ${value}`)
      return lines.join('\n')
    }
  }
  if (document.trim() === '') return `${key}: ${value}\n`
  return `${document.trimEnd()}\n\n# Added by ${key} setting\n${key}: ${value}\n`
}

/**
 * Reject identifiers that could break out of the profile directory through path
 * traversal or separator tricks, keeping ids to a safe character class.
 */
function sanitizeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'profile id contains invalid characters')
  }
  return id
}
