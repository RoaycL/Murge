import type { FileLogLevel, FileLogService } from './file-log-service'

type ConsoleMethod = 'debug' | 'log' | 'warn' | 'error'

const LEVEL_BY_METHOD: Record<ConsoleMethod, FileLogLevel> = {
  debug: 'debug',
  log: 'info',
  warn: 'warn',
  error: 'error'
}

/** Tee main-process console output into the bounded application log. */
export function installConsoleFileLogging(logs: FileLogService): () => void {
  const original: Record<ConsoleMethod, (...values: unknown[]) => void> = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }
  for (const method of Object.keys(original) as ConsoleMethod[]) {
    console[method] = (...values: unknown[]): void => {
      original[method](...values)
      void logs.writeApp(LEVEL_BY_METHOD[method], values).catch((error) => {
        original.error('[logging] failed to persist application log:', error)
      })
    }
  }
  return () => {
    for (const method of Object.keys(original) as ConsoleMethod[]) console[method] = original[method]
  }
}
