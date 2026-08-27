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
// Run as a CLI:
//   node scripts/kernel-watchdog-cleanup.mjs --evidence <path>
// Or import { cleanupKernel } from a test (it accepts everything the CI step
// takes and returns a structured result, throwing on failure).
import { readFile, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const isWin = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const LISTEN_STATE = isWin ? 'LISTENING' : 'LISTEN'

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

/** Best-effort kill of a single pid; returns true if it was alive and killed. */
export async function killPid(pid) {
  if (!pidAlive(pid)) return false
  if (isWin) {
    await execFileAsync('taskkill', ['/PID', String(pid), '/F']).catch(() => undefined)
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  return true
}

/** All PIDs whose executable resolves to `mihomo`/`mihomo.exe`. */
export async function mihomoPids() {
  const pids = []
  if (isWin) {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH']).catch(() => ({ stdout: '' }))
    for (const line of stdout.split('\n')) {
      const fields = parseCsvLine(line)
      if (fields[0] && /^mihomo/i.test(fields[0])) {
        const pid = Number(fields[1])
        if (Number.isInteger(pid) && pid > 0) pids.push(pid)
      }
    }
  } else {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm']).catch(() => ({ stdout: '' }))
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (match && /^mihomo/i.test(match[2].trim().split('/').pop())) {
        pids.push(Number(match[1]))
      }
    }
  }
  return [...new Set(pids)]
}

/** True when a TCP listener on `port` exists (uses netstat/ss output). */
export async function portHasListener(port) {
  const stdout = isWin
    ? (await execFileAsync('netstat', ['-ano', '-p', 'TCP']).catch(() => ({ stdout: '' }))).stdout
    : (await execFileAsync('ss', ['-ltna']).catch(() => ({ stdout: '' }))).stdout
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const tokens = line.split(/\s+/)
    if (!tokens.includes(LISTEN_STATE)) continue
    for (const token of tokens) {
      const parsed = parseHostPort(token)
      if (parsed && parsed.port === port) return true
    }
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
 * Reap the kernel recorded in `evidencePath` and prove cleanup.
 *
 * @param {string} evidencePath JSON evidence written by the real-kernel test.
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {Promise<{ok: true, action: string, pid: number, ports: number[], workspace?: string}>}
 * @throws when a residual process/port/workspace remains.
 */
export async function cleanupKernel(evidencePath, opts = {}) {
  const log = opts.log ?? (() => {})
  let ev
  try {
    const raw = await readFile(evidencePath, 'utf8')
    ev = JSON.parse(raw)
  } catch {
    log('no kernel evidence file; nothing to clean up')
    return { ok: true, action: 'skip', pid: 0, ports: [] }
  }
  log(`evidence: pid=${ev.pid} controller=${ev.controllerPort} mixed=${ev.mixedPort}`)

  const recordedPid = Number(ev.pid)

  // 1) Kill the recorded PID (the watchdog-restarted process, if it is live).
  if (recordedPid > 0 && pidAlive(recordedPid)) {
    log(`stopping recorded PID ${recordedPid}`)
    await killPid(recordedPid)
    await sleep(2000)
  }
  if (recordedPid > 0 && pidAlive(recordedPid)) {
    throw new Error(`recorded mihomo PID ${recordedPid} still alive after kill`)
  }
  log(`recorded mihomo PID ${recordedPid} is gone`)

  // 2) Kill + prove no residual mihomo.
  const residual = await mihomoPids()
  if (residual.length) {
    log(`found residual mihomo process(es): ${residual.join(', ')}; terminating on disposable runner`)
    for (const pid of residual) await killPid(pid)
    await sleep(2000)
  }
  const still = await mihomoPids()
  if (still.length) {
    throw new Error(`a mihomo process remains after reaping the recorded PID and residuals: ${still.join(', ')}`)
  }
  log('no mihomo process remains')

  // 3) Both test ports must be released.
  const ports = [Number(ev.controllerPort), Number(ev.mixedPort)].filter((p) => Number.isInteger(p) && p > 0)
  const open = []
  for (const port of ports) {
    if (await portHasListener(port)) open.push(port)
  }
  if (open.length) throw new Error(`test port still listening: ${open.join(', ')}`)
  if (ports.length) log(`test ports released: ${ports.join(', ')}`)

  // 4) Leftover store child + top-level workspace removed.
  if (ev.workspace) {
    const configDir = ev.configDir || join(ev.workspace, 'config')
    const children = (await readdir(configDir).catch(() => [])).filter((n) => n.startsWith('mihomo-workspace-'))
    if (children.length) {
      log(`removing ${children.length} leftover store child dir(s)`)
      for (const child of children) {
        await rm(join(configDir, child), { recursive: true, force: true }).catch(() => undefined)
      }
    }
    await rm(ev.workspace, { recursive: true, force: true }).catch(() => undefined)
    // After removing the workspace the config child is gone with it; a record of
    // the store child could only survive if the workspace removal failed.
    const remaining = (await readdir(configDir).catch(() => [])).filter((n) => n.startsWith('mihomo-workspace-'))
    if (remaining.length) throw new Error(`store config child not cleaned after removal: ${remaining.join(', ')}`)
    if (await pathExists(ev.workspace)) throw new Error(`workspace not removed: ${ev.workspace}`)
    log('temp config/secret directory cleaned and removed')
  }

  log('kernel watchdog: PASS')
  return { ok: true, action: 'cleaned', pid: recordedPid, ports, workspace: ev.workspace }
}

function parseCli(argv) {
  const opts = { evidencePath: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--evidence') opts.evidencePath = argv[++i]
  }
  return opts
}

async function main() {
  const { evidencePath } = parseCli(process.argv)
  if (!evidencePath) {
    process.stderr.write('usage: node scripts/kernel-watchdog-cleanup.mjs --evidence <path>\n')
    process.exitCode = 1
    return
  }
  try {
    await cleanupKernel(evidencePath, {
      log: (msg) => process.stdout.write(`[cleanup] ${msg}\n`)
    })
  } catch (error) {
    process.stderr.write(`[cleanup] FAIL: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
