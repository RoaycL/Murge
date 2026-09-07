import type { MihomoLogMessage } from '@shared/mihomo-api'
import { redactLogText } from '@shared/log-redaction'
import { formatWallClock, resolveSystemTimeZone } from './format'

export { redactLogText } from '@shared/log-redaction'

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

export interface DisplayLogEntry {
  id: number
  time: string
  level: LogLevel
  message: string
}

function normalizeLevel(message: MihomoLogMessage): LogLevel {
  const raw = String(message.type ?? message.level ?? 'info').toLowerCase()
  if (raw === 'warn' || raw === 'warning') return 'warning'
  if (raw === 'error' || raw === 'debug') return raw
  return 'info'
}

export function normalizeLogMessage(message: MihomoLogMessage, id: number, now = new Date()): DisplayLogEntry {
  const rawText = message.payload ?? message.message ?? ''
  const parsedTime = message.time ? new Date(message.time) : now
  return {
    id,
    time: Number.isNaN(parsedTime.getTime()) ? now.toISOString() : parsedTime.toISOString(),
    level: normalizeLevel(message),
    message: redactLogText(rawText || '(empty log message)')
  }
}

/** Human-readable log export: local-zone wall-clock time (to the second) per line. */
export function serializeLogs(entries: readonly DisplayLogEntry[], timeZone: string | null = resolveSystemTimeZone()): string {
  return entries.map((entry) => `${formatWallClock(entry.time, { timeZone })}\t${entry.level.toUpperCase()}\t${redactLogText(entry.message)}`).join('\n') + (entries.length ? '\n' : '')
}
