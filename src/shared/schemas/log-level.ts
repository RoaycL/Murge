import { z } from 'zod'

/**
 * The exact set of `log-level` values the mihomo kernel accepts.
 *
 * Mirrors mihomo's `LogLevelMapping` (log/level.go) — `silent`, `error`,
 * `warning`, `info`, `debug`. This is the single source of truth for every
 * renderer-to-main WRITE path that accepts a log level:
 * - `patchableConfigKeys` in `./ipc.ts` (live controller `PATCH /configs`), and
 * - `configEditValueByKey` in `./profiles.ts` (profile document edit).
 *
 * The READ path in `./mihomo.ts` is deliberately left permissive (`z.string()`):
 * it parses trusted kernel output with `.passthrough()`, and rejecting an unknown
 * level there would break a read with no security benefit.
 */
export const MIHOMO_LOG_LEVELS = ['silent', 'error', 'warning', 'info', 'debug'] as const

export type MihomoLogLevel = (typeof MIHOMO_LOG_LEVELS)[number]

/** zod validation for a supported log level. */
export const logLevelSchema = z.enum(MIHOMO_LOG_LEVELS)
