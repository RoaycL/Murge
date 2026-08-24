// Harmless fixture process used to prove the kernel lifecycle without a real
// kernel. It opens no network listener and configures no network state. It only:
//   - prints a `fixture-ready pid=<pid>` line to stdout,
//   - optionally emits periodic stdout/stderr ticks,
//   - optionally exits on its own after a delay,
//   - optionally ignores SIGTERM (to exercise the forced-stop path).
//
// Usage:
//   node kernel-fixture.mjs \
//     [--stdout-ms N] [--stderr-ms N] \
//     [--exit-after-ms N] [--exit-code N] [--ignore-sigterm]
import { setTimeout as sleep } from 'node:timers'

const args = process.argv.slice(2)

function readNumber(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) ? value : fallback
}

const stdoutMs = readNumber('--stdout-ms', 0)
const stderrMs = readNumber('--stderr-ms', 0)
const exitAfterMs = readNumber('--exit-after-ms', 0)
const exitCode = readNumber('--exit-code', 0)
const ignoreSigterm = args.includes('--ignore-sigterm')

const pid = process.pid
process.stdout.write(`fixture-ready pid=${pid}\n`)

let tick = 0
const stdoutTimer =
  stdoutMs > 0
    ? setInterval(() => {
        tick += 1
        process.stdout.write(`tick ${tick}\n`)
      }, stdoutMs)
    : null
const stderrTimer =
  stderrMs > 0
    ? setInterval(() => {
        process.stderr.write(`stderr tick ${tick}\n`)
      }, stderrMs)
    : null

function shutdown(code) {
  if (stdoutTimer) clearInterval(stdoutTimer)
  if (stderrTimer) clearInterval(stderrTimer)
  process.exit(code)
}

if (ignoreSigterm) {
  process.on('SIGTERM', () => process.stderr.write('fixture ignoring SIGTERM\n'))
  process.on('SIGINT', () => process.stderr.write('fixture ignoring SIGINT\n'))
} else {
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
}

if (exitAfterMs > 0) {
  sleep(() => shutdown(exitCode), exitAfterMs)
}
