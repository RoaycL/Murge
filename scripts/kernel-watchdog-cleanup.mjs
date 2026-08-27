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
// Evidence handling: the document is validated with a STRICT schema before any
// directory removal — pid must be a positive integer, both ports distinct
// integers in 1024-65535, workspace/configDir absolute non-root paths with a
// controlled `mihomo-real-*`/`mihomo-cleanup-fault-*` basename and configDir
// contained within workspace. `--allowed-workspace-roots` adds a further
// root-containment check (CI passes the disposable runner's temp dir). Because
// resolve/relative only prove the PATH STRINGS are well-formed, the schema is
// followed by a REAL-FILESYSTEM validation (`validateEvidencePaths`) that
// `lstat`s the workspace/configDir (so a symbolic link / junction / reparse
// point is never descended) and `realpath`s them (so a link that resolves
// outside an allowed root is rejected). A path that does not exist is fine —
// there is nothing to delete, so no link can be followed out of the root, and
// the real-kernel test's own afterEach removes its workspace before the CI
// `finally` cleanup runs. On a schema/path problem the script still sweeps and
// reaps residual mihomo by exact name, but NEVER removes a directory, and with
// `--require-evidence` (used by CI and the fault-injection step) the run FAILS.
// Without `--require-evidence` a missing/corrupt evidence file is reported
// honestly (no "nothing to clean up" PASS) after the sweep.
// Residual mihomo (and the recorded PID) are matched only by the strict
// `isMihomoName` (mihomo/mihomo.exe), never by a prefix, so an approximate name
// like mihomo-helper.exe or mihomo-ui.exe can never be signalled.
//
// CLI:
//   node scripts/kernel-watchdog-cleanup.mjs --evidence <path> [--require-evidence] [--allowed-workspace-roots <dir>]
// Or import { cleanupKernel } from a test (tests inject a mock `runner`).
import { readFile, rm, readdir, stat, lstat, realpath, unlink } from 'node:fs/promises'
import { join, resolve, relative, basename, isAbsolute, parse } from 'node:path'
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

/** Only a workspace whose basename starts with one of these may be removed. */
const WORKSPACE_PREFIXES = ['mihomo-real-', 'mihomo-cleanup-fault-']

/** True when `child` resolves inside `parent` (equal is accepted). */
function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** True when `p` contains a literal `..` path segment (either separator). */
function hasDotDotSegment(p) {
  return /(^|[\\/])\.\.([\\/]|$)/.test(p)
}

/**
 * Strict schema + path-ownership validation of an evidence document. Returns a
 * list of problem strings (empty = safe to proceed). Unlike the presence-only
 * `validateEvidence`, this checks types, ranges and that the workspace/configDir
 * point at a controlled, non-root absolute path. Path problems are detected
 * BEFORE any directory removal so a crafted evidence file can never widen the
 * `rm` scope.
 */
export function validateEvidenceSchema(ev, opts = {}) {
  const problems = []
  if (!ev || typeof ev !== 'object') return ['<evidence-not-an-object>']
  const allowedRoots = Array.isArray(opts.allowedWorkspaceRoots) ? opts.allowedWorkspaceRoots : []

  // pid must be a positive integer number.
  if (!Number.isInteger(ev.pid) || ev.pid <= 0) {
    problems.push(`pid must be a positive integer; got ${JSON.stringify(ev.pid)}`)
  }

  // Both ports must be distinct integers in the ephemeral range.
  for (const key of ['controllerPort', 'mixedPort']) {
    const v = ev[key]
    if (!Number.isInteger(v) || v < 1024 || v > 65535) {
      problems.push(`${key} must be an integer in 1024-65535; got ${JSON.stringify(v)}`)
    }
  }
  if (
    Number.isInteger(ev.controllerPort) &&
    Number.isInteger(ev.mixedPort) &&
    ev.controllerPort === ev.mixedPort
  ) {
    problems.push('controllerPort and mixedPort must be different ports')
  }

  // workspace: absolute, non-root, controlled basename, no `..`, under an allowed root.
  if (typeof ev.workspace !== 'string' || !ev.workspace) {
    problems.push('workspace must be a non-empty absolute path')
  } else if (!isAbsolute(ev.workspace)) {
    problems.push(`workspace must be an absolute path; got ${ev.workspace}`)
  } else {
    const ws = resolve(ev.workspace)
    const base = basename(ws)
    if (parse(ws).root === ws) {
      problems.push(`workspace must not be a filesystem root; got ${ev.workspace}`)
    } else if (!WORKSPACE_PREFIXES.some((p) => base.startsWith(p))) {
      problems.push(
        `workspace basename must start with '${WORKSPACE_PREFIXES.join("' or '")}'; got '${base}'`
      )
    } else if (hasDotDotSegment(ev.workspace)) {
      problems.push(`workspace must not contain '..'; got ${ev.workspace}`)
    } else if (allowedRoots.length && !allowedRoots.some((root) => isWithin(root, ws))) {
      problems.push(`workspace is outside allowed roots: ${ev.workspace}`)
    }
  }

  // configDir: absolute, non-root, no `..`, and contained within workspace.
  if (typeof ev.configDir !== 'string' || !ev.configDir) {
    problems.push('configDir must be a non-empty absolute path')
  } else if (!isAbsolute(ev.configDir)) {
    problems.push(`configDir must be an absolute path; got ${ev.configDir}`)
  } else {
    const cfg = resolve(ev.configDir)
    if (parse(cfg).root === cfg) {
      problems.push(`configDir must not be a filesystem root; got ${ev.configDir}`)
    } else if (hasDotDotSegment(ev.configDir)) {
      problems.push(`configDir must not contain '..'; got ${ev.configDir}`)
    } else if (
      typeof ev.workspace === 'string' &&
      isAbsolute(ev.workspace) &&
      !isWithin(resolve(ev.workspace), cfg)
    ) {
      problems.push(`configDir must be within workspace; got ${ev.configDir}`)
    }
  }

  return problems
}

/**
 * REAL-FILESYSTEM path validation of an evidence document. The synchronous
 * `validateEvidenceSchema` only proves the path STRINGS are well formed; this
 * follows symlinks/junctions/reparse points via `lstat`/`realpath` so the ACTUAL
 * directory we would `rm` is proven to resolve inside an allowed root and is not
 * a link that points out of it. Returns a list of problem strings (empty = safe
 * to remove).
 *
 * Semantics:
 *  - A path that does not exist (ENOENT) is NOT a problem: there is nothing to
 *    delete, so no link can be followed outside the allowed root. (The real
 *    kernel test's afterEach removes its own workspace before the CI `finally`
 *    cleanup runs, so a missing path is the normal, not a suspicious, case.)
 *  - A path that EXISTS but is a symbolic link / junction / reparse point IS a
 *    problem: we refuse to descend into it, so a path that has a `mihomo-real-*`
 *    name but links out of the root can never widen the `rm` scope.
 *  - Realpath containment is enforced as defense-in-depth even when `lstat`
 *    does not flag the path as a link: if the resolved target escapes an allowed
 *    root (or the workspace), the path is rejected.
 */
export async function validateEvidencePaths(ev, opts = {}) {
  const problems = []
  if (!ev || typeof ev !== 'object') return ['<evidence-not-an-object>']
  const allowedRoots = Array.isArray(opts.allowedWorkspaceRoots) ? opts.allowedWorkspaceRoots : []

  // Resolve the real target of every allowed root. A configured root that cannot
  // be realpath'd is not usable for containment; if NO configured root resolves,
  // containment cannot be proven and the path is rejected. (If no roots are
  // configured at all, containment is intentionally skipped — the caller chooses
  // whether to enforce it, e.g. CI passes the runner's temp root.)
  const realRoots = []
  for (const root of allowedRoots) {
    try {
      realRoots.push(await realpath(root))
    } catch {
      // unresolvable root: ignore, checked below when nothing resolves
    }
  }
  const haveRoots = allowedRoots.length > 0

  // --- workspace ---------------------------------------------------------------
  let realWorkspace = null
  try {
    const stats = await lstat(ev.workspace)
    if (stats.isSymbolicLink()) {
      problems.push(`workspace is a symbolic link/reparse point; refusing to descend: ${ev.workspace}`)
      return problems
    }
    realWorkspace = await realpath(ev.workspace)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      problems.push(`cannot stat workspace ${ev.workspace}: ${error.message}`)
      return problems
    }
    // ENOENT: already gone => nothing to delete, no escape possible.
  }

  if (realWorkspace) {
    if (haveRoots && !realRoots.length) {
      problems.push('allowed workspace roots configured but none resolvable; refusing to delete')
    } else if (haveRoots && !realRoots.some((root) => isWithin(root, realWorkspace))) {
      problems.push(
        `workspace real path '${realWorkspace}' is outside allowed roots: ${allowedRoots.join(', ')}`
      )
    }
  }

  // --- configDir ---------------------------------------------------------------
  try {
    const stats = await lstat(ev.configDir)
    if (stats.isSymbolicLink()) {
      problems.push(`configDir is a symbolic link/reparse point; refusing to descend: ${ev.configDir}`)
    } else {
      const realConfig = await realpath(ev.configDir)
      if (realWorkspace) {
        if (!isWithin(realWorkspace, realConfig)) {
          problems.push(`configDir real path '${realConfig}' is outside workspace '${realWorkspace}'`)
        } else if (relative(realWorkspace, realConfig) !== 'config') {
          problems.push(`configDir must be '<workspace>/config'; got ${ev.configDir}`)
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      problems.push(`cannot stat configDir ${ev.configDir}: ${error.message}`)
    }
  }

  return problems
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
      if (isMihomoName(name)) pids.push(pid)
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
      if (isMihomoName(name)) pids.push(Number(match[1]))
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
  // Controlled roots: when provided, the evidence workspace must resolve inside
  // at least one of them. CI passes the disposable runner's temp directory so a
  // crafted evidence file can never widen the `rm` scope.
  const allowedWorkspaceRoots = Array.isArray(opts.allowedWorkspaceRoots) ? opts.allowedWorkspaceRoots : []

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
    const schemaProblems = validateEvidenceSchema(ev, { allowedWorkspaceRoots })
    if (schemaProblems.length) {
      evidenceProblem = new Error(
        `kernel evidence '${evidencePath}' fails schema validation: ${schemaProblems.join('; ')}`
      )
      log(evidenceProblem.message)
    }
  }
  // Real-filesystem validation: the lexical schema above cannot see through a
  // symlink/junction/reparse point, so follow the paths with lstat/realpath and
  // reject an existing link (or a resolved target that escapes an allowed root)
  // BEFORE any directory removal. A path that does not exist is not a problem.
  if (ev && !evidenceProblem) {
    const pathProblems = await validateEvidencePaths(ev, { allowedWorkspaceRoots })
    if (pathProblems.length) {
      evidenceProblem = new Error(
        `kernel evidence '${evidencePath}' fails real-path validation: ${pathProblems.join('; ')}`
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
            // The evidence claims a different binary than the process actually is.
            // Treat the recorded PID as stale/reused: do NOT trust it for the kill.
            // The exact-name residual sweep below still reaps a real mihomo.
            log(
              `recorded PID ${recordedPid} is ${name} but binaryPath basename is '${String(
                ev.binaryPath
              ).split(/[\\/]/).pop()}'; refusing to terminate (stale/reused PID)`
            )
          } else {
            log(`stopping recorded PID ${recordedPid}`)
            await killPid(recordedPid, runner)
            await (runner.sleep || sleep)(2000)
            if (aliveCheck(recordedPid)) {
              throw new Error(`recorded mihomo PID ${recordedPid} still alive after kill`)
            }
            log(`recorded mihomo PID ${recordedPid} is gone`)
          }
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
        const childPath = join(configDir, child)
        // Never follow a symlink/junction child into its target: remove only the
        // link itself, so a crafted `mihomo-workspace-*` link can never widen the
        // `rm` scope to a directory it points at outside the allowed root.
        let isLink = false
        try {
          isLink = (await lstat(childPath)).isSymbolicLink()
        } catch {
          isLink = false
        }
        if (isLink) {
          log(`removing leftover store child symlink ${child}`)
          await unlink(childPath).catch(() => undefined)
        } else {
          await rm(childPath, { recursive: true, force: true }).catch(() => undefined)
        }
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
  const opts = { evidencePath: null, requireEvidence: false, allowedWorkspaceRoots: [] }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--evidence') opts.evidencePath = argv[++i]
    else if (argv[i] === '--require-evidence') opts.requireEvidence = true
    else if (argv[i] === '--allowed-workspace-roots') {
      const value = String(argv[++i] || '').trim()
      if (value) for (const root of value.split(',')) if (root.trim()) opts.allowedWorkspaceRoots.push(root.trim())
    }
  }
  return opts
}

async function main() {
  const { evidencePath, requireEvidence, allowedWorkspaceRoots } = parseCli(process.argv)
  if (!evidencePath) {
    process.stderr.write(
      'usage: node scripts/kernel-watchdog-cleanup.mjs --evidence <path> [--require-evidence] [--allowed-workspace-roots <dir>]\n'
    )
    process.exitCode = 1
    return
  }
  try {
    await cleanupKernel(evidencePath, {
      log: (msg) => process.stdout.write(`[cleanup] ${msg}\n`),
      requireEvidence,
      allowedWorkspaceRoots
    })
  } catch (error) {
    process.stderr.write(`[cleanup] FAIL: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
