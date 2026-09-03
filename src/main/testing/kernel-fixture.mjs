// Harmless fixture process used to prove the kernel lifecycle without a real
// kernel. It opens no network listener and configures no network state. It only:
//   - prints a `fixture-ready pid=<pid>` line to stdout,
//   - stays alive until it is signalled or killed (like a real kernel would),
//   - optionally emits periodic stdout/stderr ticks,
//   - optionally exits on its own after a delay,
//   - optionally ignores SIGTERM (to exercise the forced-stop path).
//
// Usage:
//   node kernel-fixture.mjs \
//     [--stdout-ms N] [--stderr-ms N] \
//     [--exit-after-ms N] [--exit-code N] [--ignore-sigterm]
import { setTimeout as sleep } from 'node:timers'

// A real kernel keeps running until it is stopped, so the fixture must too. With
// no tick interval and no --exit-after-ms there is otherwise nothing referenced
// by the event loop once the ready line is flushed, and the fixture exits
// immediately after printing it — which is indistinguishable from an instant
// crash to the supervisor. A SIGTERM/SIGINT listener does not hold the loop open
// on Windows, so an explicit referenced handle is required.
const MAX_LIFETIME_MS = 5 * 60 * 1000

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

// The referenced lifetime cap is what holds the event loop open, so the fixture
// keeps running until it is signalled or killed. It also bounds a fixture leaked
// by a crashed test run so it can never linger.
const lifetimeCap = sleep(() => shutdown(0), MAX_LIFETIME_MS)

function shutdown(code) {
  if (stdoutTimer) clearInterval(stdoutTimer)
  if (stderrTimer) clearInterval(stderrTimer)
  clearTimeout(lifetimeCap)
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
