import type { MihomoLogMessage } from '@shared/mihomo-api'

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

export interface DisplayLogEntry {
  id: number
  time: string
  level: LogLevel
  message: string
}

const SENSITIVE_KEY = /(access[_-]?token|api[_-]?key|authorization|cookie|password|secret|token)/i

/** Remove credentials before a log is retained by renderer state or exported. */
export function redactLogText(input: string): string {
  let text = input
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
  text = text.replace(/([?&])([^=&\s]+)=([^&\s]*)/g, (match, separator: string, key: string) =>
    SENSITIVE_KEY.test(key) ? `${separator}${key}=[REDACTED]` : match
  )
  text = text.replace(/\b((?:authorization|cookie)|[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)\s*[:=]\s*([^&\s,;]+)/gi, '$1=[REDACTED]')
  text = text.replace(/\b(https?:\/\/)([^/@\s]+)@/gi, '$1[REDACTED]@')
  return text
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

export function serializeLogs(entries: readonly DisplayLogEntry[]): string {
  return entries.map((entry) => `${entry.time}\t${entry.level.toUpperCase()}\t${redactLogText(entry.message)}`).join('\n') + (entries.length ? '\n' : '')
}
