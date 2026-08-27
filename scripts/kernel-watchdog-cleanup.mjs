#!/usr/bin/env node
// Shared mihomo watchdog cleanup — used by BOTH the Windows CI `if: always()`
// finally step AND the real-kernel fault-injection test, so the test is not
// exercising a duplicate copy.
//
// It reaps exactly the process recorded in the evidence file (and any residual
// mihomo on the disposable runner), proves the two listener ports are released,
// and removes the leftover store workspace — throwing on any residual so a dirty
// runner fails the job instead of silently passing.
//
// Fail-closed probes: if `tasklist`/`ps`/`netstat`/`ss` cannot be run, or return
// blank/unparseable output, the script THROWS rather than reporting "no residual"
// or "ports released". A live recorded PID is killed ONLY after the OS confirms
// its executable is still `mihomo`/`mihomo.exe`, so a recycled PID can never take
// down an unrelated runner process.
//
// Evidence handling: by default a missing/corrupt evidence file is reported
// honestly (no "nothing to clean up" PASS) after sweeping residual mihomo. With
// `--require-evidence` (used by CI and the fault-injection step) a missing,
// corrupt or field-incomplete evidence file FAILS the run, while still leaving the
// disposable runner free of residual mihomo.
//
// CLI:
//   node scripts/kernel-watchdog-cleanup.mjs --evidence <path> [--require-evidence]
// Or import { cleanupKernel } from a test (tests inject a mock `runner`).
import { readFile, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const isWin = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const LISTEN_STATE = isWin ? 'LISTENING' : 'LISTEN'

/**
 * The fields a reaping-usable evidence document must carry. The enriched
 * verification facts (binary path, version, listener hosts, /version result,
 * network-diff PASS) are optional: they describe the run but are not needed to
 * reap the process or prove the ports/workspace are released.
 */
export const REQUIRED_EVIDENCE_FIELDS = ['pid', 'controllerPort', 'mixedPort', 'workspace', 'configDir']

/** Default command runner over the real OS tools. Tests inject a mock. */
export function defaultRunner() {
  return {
    isWin,
    exec: execFileAsync,
    pidAlive,
    sleep
  }
}

/** True when `name` is strictly `mihomo` or `mihomo.exe` (case-insensitive). */
export function isMihomoName(name) {
  if (!name) return false
  const n = name.toLowerCase()
  return n === 'mihomo' || n === 'mihomo.exe'
}

/** Whether `binaryPath`'s basename matches the observed process name. */
export function binaryPathMatchesName(binaryPath, name) {
  if (!binaryPath || !name) return false
  const base = String(binaryPath).split(/[\\/]/).pop().toLowerCase()
  const n = String(name).split(/[\\/]/).pop().toLowerCase()
  return base === n
}

/** Return the list of required evidence fields that are missing/empty. */
export function validateEvidence(ev) {
  if (!ev || typeof ev !== 'object') return ['<evidence-not-an-object>']
  return REQUIRED_EVIDENCE_FIELDS.filter((f) => ev[f] === undefined || ev[f] === null || ev[f] === '')
}

/** Parse a `host:port` token, including IPv6 bracket form `[::1]:8080`. */
function parseHostPort(token) {
  const bracketed = token.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) }
  const idx = token.lastIndexOf(':')
  if (idx <= 0) return null
  const host = token.slice(0, idx)
  const port = Number(token.slice(idx + 1))
  if (!Number.isInteger(port) || port <= 0) return null
  return { host, port }
}

/** Split one `tasklist /FO CSV` line into its quoted/unquoted fields. */
function parseCsvLine(line) {
  const fields = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      let j = i + 1
      let val = ''
      while (j < line.length) {
        if (line[j] === '"') {
          if (line[j + 1] === '"') {
            val += '"'
            j += 2
          } else {
            j++
            break
          }
        } else {
          val += line[j]
          j++
        }
      }
      fields.push(val)
      i = j
      if (line[i] === ',') i++
    } else {
      let j = i
      while (j < line.length && line[j] !== ',') j++
      fields.push(line.slice(i, j))
      i = j + 1
    }
  }
  return fields
}

/** True when `pid` refers to a live process (EPERM => exists, ESRCH => gone). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/** Run a probe command and throw a descriptive error on failure (fail closed). */
async function execOrThrow(runner, tool, args, what) {
  try {
    return await runner.exec(tool, args)
  } catch (error) {
    throw new Error(`${what} failed (${tool}): ${error.message}`)
  }
}

/**
 * Executable identity of `pid`, or null when the PID is not running (or not
 * visible). Probes fail closed: if the tool itself cannot run, this throws.
 * Windows returns the Image Name; Unix returns the `comm` (command) name.
 */
export async function processIdentity(pid, runner = defaultRunner()) {
  if (runner.isWin) {
    // tasklist /FI "PID eq X" returns at most the matching process row, or a
    // non-CSV INFO line when no process matches (=> null).
    const { stdout } = await execOrThrow(
      runner,
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      `process identity probe for PID ${pid}`
    )
    const line = (stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    if (!line) return null
    const fields = parseCsvLine(line)
    const name = fields[0]
    const rowPid = Number(fields[1])
    if (Number.isInteger(rowPid) && rowPid !== pid) return null // not the asked-for PID
    if (!name) return null
    return { name, path: null }
  }
  const { stdout } = await execOrThrow(
    runner,
    'ps',
    ['-o', 'comm=', '-p', String(pid)],
    `process identity probe for PID ${pid}`
  )
  const name = (stdout || '').trim()
  if (!name) return null
  return { name, path: null }
}

/**
 * All PIDs whose executable resolves to `mihomo`/`mihomo.exe`. Fail closed: an
 * unparseable probe (or one that yields no parsing record) throws so an unknown
 * state is never mistaken for "no residual".
 */
export async function mihomoPids(runner = defaultRunner()) {
  const pids = []
  let stdout
  let tool
  if (runner.isWin) {
    tool = 'tasklist'
    const res = await execOrThrow(runner, 'tasklist', ['/FO', 'CSV', '/NH'], 'process probe')
    stdout = res.stdout
  } else {
    tool = 'ps'
    // `pid=,comm=` suppresses the PID/COMMAND header so a healthy run yields only
    // data rows; a blank output still reliably means "no processes" and we fail
    // closed on it, so a broken `ps` can never be read as "no residual".
    const res = await execOrThrow(runner, 'ps', ['-eo', 'pid=,comm='], 'process probe')
    stdout = res.stdout
  }
  if (!stdout || !stdout.trim()) {
    throw new Error(`${tool} process probe returned no parseable output; cannot prove no residual mihomo`)
  }
  if (runner.isWin) {
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const fields = parseCsvLine(line)
      const name = (fields[0] || '').trim()
      const pid = Number(fields[1])
      // A healthy Windows `tasklist` dump includes pseudo-process rows like
      // PID 0 ("System Idle Process") that are valid but never a target; skip
      // them. Only a genuinely malformed row (fewer than the PID/name columns,
      // or a non-numeric PID such as a stray "PID" field) is "unparseable" and
      // must fail closed so a broken `tasklist` is never read as "no residual".
      if (fields.length < 2 || !Number.isInteger(pid)) {
        throw new Error(`tasklist process probe output unparseable row: ${JSON.stringify(trimmed)}`)
      }
      if (pid <= 0) continue
      if (/^mihomo/i.test(name)) pids.push(pid)
    }
  } else {
    let sawData = false
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // Defensively skip a ps column header (e.g. "PID COMMAND") that some
      // platforms emit despite the header suppression; never treat a malformed
      // DATA line as proof of absence.
      if (!/^\d/.test(trimmed)) continue
      sawData = true
      const match = trimmed.match(/^(\d+)\s+(.+)$/)
      if (!match) {
        throw new Error(`ps process probe output unparseable row: ${JSON.stringify(trimmed)}`)
      }
      const name = match[2].trim().split('/').pop()
      if (/^mihomo/i.test(name)) pids.push(Number(match[1]))
    }
    if (!sawData) {
      throw new Error(`${tool} process probe returned no parseable process rows; cannot prove no residual mihomo`)
    }
  }
  return [...new Set(pids)]
}

/**
 * True when a TCP listener on `port` exists. Fail closed: running the probe that
 * fails, returning blank output, or emitting LISTENING rows with no parseable
 * address all throw so a broken listener probe is never read as "released".
 */
export async function portHasListener(port, runner = defaultRunner()) {
  let stdout
  let tool
  if (runner.isWin) {
    tool = 'netstat'
    const res = await execOrThrow(runner, 'netstat', ['-ano', '-p', 'TCP'], 'listener probe')
    stdout = res.stdout
  } else {
    tool = 'ss'
    const res = await execOrThrow(runner, 'ss', ['-ltna'], 'listener probe')
    stdout = res.stdout
  }
  if (!stdout || !stdout.trim()) {
    throw new Error(`${tool} listener probe returned no parseable output; cannot prove port ${port} released`)
  }
  const state = runner.isWin ? 'LISTENING' : 'LISTEN'
  let sawListen = false
  let sawAddress = false
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const tokens = line.split(/\s+/)
    if (!tokens.includes(state)) continue
    sawListen = true
    for (const token of tokens) {
      const parsed = parseHostPort(token)
      if (parsed) {
        sawAddress = true
        if (parsed.port === port) return true
      }
    }
  }
  if (sawListen && !sawAddress) {
    throw new Error(`${tool} listener probe output unparseable (saw ${state} rows but no host:port); cannot prove port ${port} released`)
  }
  return false
}

export async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Best-effort kill of a single pid (the caller re-probes to prove it is gone).
 * NEVER called for a process whose identity is not mihomo — that gate lives in
 * `cleanupKernel`, so an unrelated recycled PID is untouched.
 */
export async function killPid(pid, runner = defaultRunner()) {
  const aliveCheck = runner.pidAlive || pidAlive
  if (!aliveCheck(pid)) return false
  if (runner.isWin) {
    await runner.exec('taskkill', ['/PID', String(pid), '/F']).catch(() => undefined)
  } else {
    await runner.exec('kill', ['-9', String(pid)]).catch(() => undefined)
  }
  return true
}

/**
 * Reap the kernel recorded in `evidencePath` and prove cleanup.
 *
 * @param {string} evidencePath JSON evidence written by the real-kernel test.
 * @param {{
 *   log?: (msg: string) => void,
 *   requireEvidence?: boolean,
 *   runner?: {isWin: boolean, exec: Function, pidAlive?: (pid:number)=>boolean}
 * }} [opts]
 * @returns {Promise<{ok: true, action: string, pid: number, ports: number[], workspace?: string, verified: boolean}>}
 * @throws when a residual process/port/workspace remains, when evidence is
 *   missing/corrupt/incomplete in require-evidence mode, or when a probe fails.
 */
export async function cleanupKernel(evidencePath, opts = {}) {
  const log = opts.log ?? (() => {})
  const requireEvidence = opts.requireEvidence === true
  const runner = opts.runner ?? defaultRunner()
  const aliveCheck = runner.pidAlive || pidAlive

  // --- Load + validate evidence ------------------------------------------------
  let ev = null
  let evidenceProblem = null
  try {
    const raw = await readFile(evidencePath, 'utf8')
    ev = JSON.parse(raw)
  } catch (error) {
    evidenceProblem = new Error(`kernel evidence '${evidencePath}' missing or unreadable: ${error.message}`)
    log(evidenceProblem.message)
  }
  if (ev && !evidenceProblem) {
    const missing = validateEvidence(ev)
    if (missing.length) {
      evidenceProblem = new Error(
        `kernel evidence '${evidencePath}' incomplete; missing required field(s): ${missing.join(', ')}`
      )
      log(evidenceProblem.message)
    }
  }
  if (ev && !evidenceProblem) {
    log(`evidence: pid=${ev.pid} controller=${ev.controllerPort} mixed=${ev.mixedPort}`)
  }

  // --- 1) Recorded PID: kill only after confirming it is still mihomo ----------
  if (ev && !evidenceProblem) {
    const recordedPid = Number(ev.pid)
    if (recordedPid > 0) {
      if (aliveCheck(recordedPid)) {
        const identity = await processIdentity(recordedPid, runner)
        const name = identity ? identity.name : null
        if (name && isMihomoName(name)) {
          if (ev.binaryPath && !binaryPathMatchesName(ev.binaryPath, name)) {
            log(
              `warning: recorded PID ${recordedPid} is ${name} but binaryPath basename is ${String(
                ev.binaryPath
              ).split(/[\\/]/).pop()}; continuing (name is mihomo)`
            )
          }
          log(`stopping recorded PID ${recordedPid}`)
          await killPid(recordedPid, runner)
          await (runner.sleep || sleep)(2000)
          if (aliveCheck(recordedPid)) {
            throw new Error(`recorded mihomo PID ${recordedPid} still alive after kill`)
          }
          log(`recorded mihomo PID ${recordedPid} is gone`)
        } else {
          // Alive but its identity is NOT mihomo (or could not be read): this is a
          // recycled/stale PID. NEVER kill an unrelated runner process.
          log(
            `recorded PID ${recordedPid} is alive but NOT mihomo (identity=${
              name || 'unknown'
            }); refusing to terminate (stale/reused PID)`
          )
        }
      } else {
        log(`recorded mihomo PID ${recordedPid} is gone`)
      }
    } else {
      log(`recorded PID ${recordedPid} is not a positive integer; skipping recorded-PID reap`)
    }
  }

  // --- 2) Always enumerate + reap residual mihomo, then prove none remains -----
  const residual = await mihomoPids(runner)
  if (residual.length) {
    log(`found residual mihomo process(es): ${residual.join(', ')}; terminating on disposable runner`)
    for (const pid of residual) await killPid(pid, runner)
    await (runner.sleep || sleep)(2000)
  }
  const still = await mihomoPids(runner)
  if (still.length) {
    throw new Error(`a mihomo process remains after reaping the recorded PID and residuals: ${still.join(', ')}`)
  }
  log('no mihomo process remains')

  // --- 3) Both test ports must be released (needs a valid evidence record) -----
  let ports = []
  if (ev && !evidenceProblem) {
    ports = [Number(ev.controllerPort), Number(ev.mixedPort)].filter((p) => Number.isInteger(p) && p > 0)
    const open = []
    for (const port of ports) {
      if (await portHasListener(port, runner)) open.push(port)
    }
    if (open.length) throw new Error(`test port still listening: ${open.join(', ')}`)
    if (ports.length) log(`test ports released: ${ports.join(', ')}`)
  }

  // --- 4) Leftover store child + workspace removed (needs a valid record) ------
  if (ev && !evidenceProblem && ev.workspace) {
    const configDir = ev.configDir || join(ev.workspace, 'config')
    const children = (await readdir(configDir).catch(() => [])).filter((n) => n.startsWith('mihomo-workspace-'))
    if (children.length) {
      log(`removing ${children.length} leftover store child dir(s)`)
      for (const child of children) {
        await rm(join(configDir, child), { recursive: true, force: true }).catch(() => undefined)
      }
    }
    await rm(ev.workspace, { recursive: true, force: true }).catch(() => undefined)
    const remaining = (await readdir(configDir).catch(() => [])).filter((n) => n.startsWith('mihomo-workspace-'))
    if (remaining.length) throw new Error(`store config child not cleaned after removal: ${remaining.join(', ')}`)
    if (await pathExists(ev.workspace)) throw new Error(`workspace not removed: ${ev.workspace}`)
    log('temp config/secret directory cleaned and removed')
  }

  // --- Final gate: require-evidence mode must fail on a missing/bad record -----
  if (evidenceProblem && requireEvidence) throw evidenceProblem

  if (!evidenceProblem) {
    log('kernel watchdog: PASS')
    return { ok: true, action: 'cleaned', pid: ev.pid, ports, workspace: ev.workspace, verified: true }
  }

  // Non-require mode with absent/corrupt evidence: we swept residual mihomo and
  // proved none remains, but could not verify ports/workspace — so do NOT claim PASS.
  return { ok: true, action: 'no-evidence', verified: false, pid: 0, ports: [] }
}

function parseCli(argv) {
  const opts = { evidencePath: null, requireEvidence: false }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--evidence') opts.evidencePath = argv[++i]
    else if (argv[i] === '--require-evidence') opts.requireEvidence = true
  }
  return opts
}

async function main() {
  const { evidencePath, requireEvidence } = parseCli(process.argv)
  if (!evidencePath) {
    process.stderr.write('usage: node scripts/kernel-watchdog-cleanup.mjs --evidence <path> [--require-evidence]\n')
    process.exitCode = 1
    return
  }
  try {
    await cleanupKernel(evidencePath, {
      log: (msg) => process.stdout.write(`[cleanup] ${msg}\n`),
      requireEvidence
    })
  } catch (error) {
    process.stderr.write(`[cleanup] FAIL: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
