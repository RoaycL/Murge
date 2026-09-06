import { inflateRawSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * Minimal ZIP reader for the Sub-Store frontend distribution (dist.zip).
 *
 * Scope is deliberately narrow — the archive is a Vite build produced by the
 * official Sub-Store-Front-End release: no zip64, no encryption, no split
 * archives, only stored (0) and deflate (8) entries. Anything outside that
 * scope is rejected loudly instead of mis-extracted. A dedicated ~120-line
 * reader avoids adding a runtime dependency (party ships adm-zip) for one
 * download path.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** EOCD: signature(4) disk(2) cdDisk(2) diskEntries(2) totalEntries(2) size(4) offset(4) commentLen(2). */
const EOCD_MIN_LEN = 22
/** Central entry: fixed 46-byte header + name/extra/comment. */
const CENTRAL_FIXED_LEN = 46
/** Local entry: fixed 30-byte header + name/extra. */
const LOCAL_FIXED_LEN = 30

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(`ZIP 解析失败：${message}`)
    this.name = 'ZipFormatError'
  }
}

interface ZipEntry {
  name: string
  isDirectory: boolean
  method: number
  compressedSize: number
  localHeaderOffset: number
}

function readU16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset)
}

function readU32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset)
}

function findEocd(buf: Buffer): number {
  // The EOCD is at the very end unless a zip comment follows; scan back the
  // maximum comment length (65535) plus the fixed record size.
  const minStart = Math.max(0, buf.length - (EOCD_MIN_LEN + 0xffff))
  for (let i = buf.length - EOCD_MIN_LEN; i >= minStart; i--) {
    if (readU32(buf, i) === EOCD_SIGNATURE) return i
  }
  throw new ZipFormatError('未找到目录结束记录（不是 ZIP 文件或已截断）')
}

function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  const entryCount = readU16(buf, eocd + 10)
  const cdSize = readU32(buf, eocd + 12)
  const cdOffset = readU32(buf, eocd + 16)
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    throw new ZipFormatError('不支持 zip64 归档')
  }
  if (cdOffset + cdSize > buf.length) throw new ZipFormatError('中央目录越界')

  const entries: ZipEntry[] = []
  let cursor = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (cursor + CENTRAL_FIXED_LEN > buf.length || readU32(buf, cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError(`中央目录第 ${i + 1} 项损坏`)
    }
    const method = readU16(buf, cursor + 10)
    const compressedSize = readU32(buf, cursor + 20)
    const nameLen = readU16(buf, cursor + 28)
    const extraLen = readU16(buf, cursor + 30)
    const commentLen = readU16(buf, cursor + 32)
    const externalAttrs = readU32(buf, cursor + 38)
    const localHeaderOffset = readU32(buf, cursor + 42)
    const name = buf.toString('utf8', cursor + CENTRAL_FIXED_LEN, cursor + CENTRAL_FIXED_LEN + nameLen)
    if (method !== 0 && method !== 8) {
      throw new ZipFormatError(`不支持的压缩方式 ${method}（${name}）`)
    }
    entries.push({
      name,
      isDirectory: name.endsWith('/') || (externalAttrs & 0x10) !== 0,
      method,
      compressedSize,
      localHeaderOffset
    })
    cursor += CENTRAL_FIXED_LEN + nameLen + extraLen + commentLen
  }
  return entries
}

function entryData(buf: Buffer, entry: ZipEntry): Buffer {
  const local = entry.localHeaderOffset
  if (local + LOCAL_FIXED_LEN > buf.length || readU32(buf, local) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(`本地头损坏（${entry.name}）`)
  }
  const nameLen = readU16(buf, local + 26)
  const extraLen = readU16(buf, local + 28)
  const dataStart = local + LOCAL_FIXED_LEN + nameLen + extraLen
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (raw.length !== entry.compressedSize) throw new ZipFormatError(`数据越界（${entry.name}）`)
  return entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
}

/**
 * Reject absolute paths and any `..` escape: the archive comes from the network
 * and the destination sits in user app-data.
 */
function assertSafeRelPath(name: string): string {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new ZipFormatError(`条目为绝对路径（${name}）`)
  }
  const parts = normalized.split('/').filter((part) => part.length > 0)
  if (parts.some((part) => part === '..')) {
    throw new ZipFormatError(`条目路径越界（${name}）`)
  }
  return parts.join('/')
}

/**
 * Extract a zip archive into `destDir`. When every entry shares one top-level
 * directory (`dist/...` for the frontend release), that prefix is stripped so
 * the output is the site root directly.
 *
 * Returns the written file paths relative to `destDir`.
 */
export async function extractZipToDir(zipPath: string, destDir: string): Promise<string[]> {
  const { readFile } = await import('node:fs/promises')
  const buf = await readFile(zipPath)
  const entries = parseCentralDirectory(buf)
  if (entries.length === 0) throw new ZipFormatError('归档为空')

  const firstSegments = new Set(
    entries.map((entry) => assertSafeRelPath(entry.name).split('/')[0]).filter(Boolean)
  )
  const stripOne = firstSegments.size === 1 && entries.every((entry) => entry.name.includes('/'))

  const resolvedDest = resolve(destDir)
  const written: string[] = []
  for (const entry of entries) {
    const rel = assertSafeRelPath(entry.name)
    const stripped = stripOne ? rel.split('/').slice(1).join('/') : rel
    if (!stripped) continue
    const target = resolve(join(resolvedDest, stripped))
    if (target !== resolvedDest && !target.startsWith(resolvedDest + sep)) {
      throw new ZipFormatError(`条目解析越界（${entry.name}）`)
    }
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entryData(buf, entry))
    written.push(stripped)
  }
  return written
}
