import { appendFile, mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { inspect } from 'node:util'
import { join } from 'node:path'
import type { MihomoLogMessage } from '@shared/mihomo-api'
import { redactLogText } from '@shared/log-redaction'

export type FileLogKind = 'app' | 'core' | 'substore'
export type FileLogLevel = 'debug' | 'info' | 'warn' | 'error'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_RETENTION_DAYS = 7
const RETAIN_RATIO = 0.5
const TRUNCATE_MARKER = Buffer.from('\n[LOG] Earlier entries were removed because the file size limit was reached.\n')
const LOG_FILE_PATTERN = /^(app|core|substore)-(\d{4})-(\d{2})-(\d{2})\.log$/

interface LogFileState {
  queue: Promise<void>
  size: number | null
}

export interface FileLogServiceOptions {
  maxFileBytes?: number
  retentionDays?: number
  now?: () => Date
}

function dateStamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function safeInspect(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  return inspect(value, {
    depth: 4,
    breakLength: Infinity,
    maxArrayLength: 50,
    maxStringLength: 4_000,
    compact: true
  })
}

/** Daily, size-capped application/core log files with bounded retention. */
export class FileLogService {
  private readonly maxFileBytes: number
  private readonly retentionDays: number
  private readonly now: () => Date
  private readonly states = new Map<string, LogFileState>()
  private initialization: Promise<void> | null = null

  constructor(readonly directory: string, options: FileLogServiceOptions = {}) {
    this.maxFileBytes = Math.max(1024, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_BYTES))
    this.retentionDays = Math.max(1, Math.floor(options.retentionDays ?? DEFAULT_RETENTION_DAYS))
    this.now = options.now ?? (() => new Date())
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = mkdir(this.directory, { recursive: true }).then(() => this.cleanupExpired())
    }
    return this.initialization
  }

  pathFor(kind: FileLogKind, date = this.now()): string {
    return join(this.directory, `${kind}-${dateStamp(date)}.log`)
  }

  writeApp(level: FileLogLevel, values: readonly unknown[], module = 'app'): Promise<void> {
    const message = values.map(safeInspect).join(' ')
    return this.write('app', `[${this.now().toISOString()}] [${level.toUpperCase()}] [${module}] ${message}\n`)
  }

  writeCore(message: MihomoLogMessage): Promise<void> {
    const date = message.time ? new Date(message.time) : this.now()
    const timestamp = Number.isNaN(date.getTime()) ? this.now().toISOString() : date.toISOString()
    const level = String(message.type ?? message.level ?? 'info').toUpperCase()
    const body = String(message.payload ?? message.message ?? '').trimEnd()
    return this.write('core', `[${timestamp}] [${level}] ${body}\n`)
  }

  writeSubStore(stream: 'stdout' | 'stderr', text: string): Promise<void> {
    const level = stream === 'stderr' ? 'ERROR' : 'INFO'
    return this.write('substore', `[${this.now().toISOString()}] [${level}] ${text.trimEnd()}\n`)
  }

  async flush(): Promise<void> {
    await this.initialize().catch(() => undefined)
    await Promise.all([...this.states.values()].map((state) => state.queue.catch(() => undefined)))
  }

  private write(kind: FileLogKind, raw: string): Promise<void> {
    const data = Buffer.from(redactLogText(raw.slice(0, 64 * 1024)), 'utf8')
    const filePath = this.pathFor(kind)
    let state = this.states.get(filePath)
    if (!state) {
      state = { queue: Promise.resolve(), size: null }
      this.states.set(filePath, state)
    }
    state.queue = state.queue
      .catch(() => undefined)
      .then(() => this.initialize())
      .then(() => this.appendLimited(filePath, data, state!))
    return state.queue
  }

  private async appendLimited(filePath: string, data: Buffer, state: LogFileState): Promise<void> {
    if (data.length === 0) return
    if (data.length >= this.maxFileBytes) {
      const tail = data.subarray(data.length - this.maxFileBytes)
      await writeFile(filePath, tail)
      state.size = tail.length
      return
    }
    if (state.size === null) {
      state.size = await stat(filePath).then((value) => value.size).catch(() => 0)
    }
    if (state.size + data.length <= this.maxFileBytes) {
      await appendFile(filePath, data)
      state.size += data.length
      return
    }
    const retainBudget = Math.floor(this.maxFileBytes * RETAIN_RATIO)
    const keepBytes = Math.max(0, retainBudget - TRUNCATE_MARKER.length - data.length)
    const tail = await this.readTail(filePath, keepBytes)
    let replacement = Buffer.concat([tail, TRUNCATE_MARKER, data])
    if (replacement.length > this.maxFileBytes) replacement = replacement.subarray(replacement.length - this.maxFileBytes)
    await writeFile(filePath, replacement)
    state.size = replacement.length
  }

  private async readTail(filePath: string, bytes: number): Promise<Buffer> {
    if (bytes <= 0) return Buffer.alloc(0)
    try {
      const file = await open(filePath, 'r')
      try {
        const size = (await file.stat()).size
        const readSize = Math.min(size, bytes)
        const buffer = Buffer.alloc(readSize)
        await file.read(buffer, 0, readSize, size - readSize)
        return buffer
      } finally {
        await file.close()
      }
    } catch {
      return Buffer.alloc(0)
    }
  }

  private async cleanupExpired(): Promise<void> {
    const today = this.now()
    const todayStamp = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
    const maxAge = this.retentionDays * 24 * 60 * 60 * 1000
    const names = await readdir(this.directory).catch(() => [])
    await Promise.all(names.map(async (name) => {
      const match = LOG_FILE_PATTERN.exec(name)
      if (!match) return
      const fileStamp = Date.UTC(Number(match[2]), Number(match[3]) - 1, Number(match[4]))
      if (!Number.isFinite(fileStamp) || todayStamp - fileStamp < maxAge) return
      await unlink(join(this.directory, name)).catch(() => undefined)
    }))
  }
}
