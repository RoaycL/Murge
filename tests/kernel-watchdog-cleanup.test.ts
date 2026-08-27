import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupKernel,
  isMihomoName,
  binaryPathMatchesName,
  mihomoPids,
  portHasListener
} from '../scripts/kernel-watchdog-cleanup.mjs'

/**
 * Cleanup-script fail-closed coverage. These tests run in the DEFAULT vitest
 * pool (not gated on a real mihomo): they inject a mock `runner` so the probe
 * functions (`tasklist`/`ps`, `netstat`/`ss`) can be made to fail, return blank
 * or malformed output, or report a recycled PID — proving the cleanup can never
 * report "no residual" / "released" / PASS on an unknown or unsafe state.
 */

interface ExecCall {
  tool: string
  args: string[]
}

interface MockRunner {
  isWin: boolean
  exec: (tool: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
  pidAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  calls: ExecCall[]
}

function tasklistCsv(rows: Array<[string, number]>): string {
  // A healthy `tasklist` ALWAYS lists at least the OS processes; an empty list
  // would be "blank output" and correctly triggers the fail-closed probe. So an
  // empty request still yields a real, non-blank listing with NO mihomo present.
  const effective = rows.length === 0 ? [['svchost.exe', 1234] as [string, number]] : rows
  return effective.map(([name, pid]) => `"${name}","${pid}","Console","1","10,000 K"`).join('\r\n')
}

function netstatOut(listeners: Array<[string, number]>): string {
  // A healthy `netstat -ano` always has at least one listener; an unrelated
  // listener means our ports are absent (= released) while the tool still ran.
  const effective = listeners.length === 0 ? [['0.0.0.0', 44411]] : listeners
  return effective.map(([host, port]) => `  TCP    ${host}:${port}    0.0.0.0:0    LISTENING    1234`).join('\n')
}

/** Build a mock runner; `handler(tool, args, callIndexForTool)` returns stdout or null to fail. */
function makeRunner(options: {
  isWin?: boolean
  handler: (tool: string, args: string[], index: number) => string | null
  pidAlive?: (pid: number) => boolean
}): MockRunner {
  const calls: ExecCall[] = []
  const callIndex: Record<string, number> = {}
  const isWin = options.isWin ?? true
  return {
    isWin,
    sleep: async () => undefined,
    pidAlive: options.pidAlive ?? (() => false),
    calls,
    exec: async (tool: string, args: string[]) => {
      calls.push({ tool, args })
      const index = callIndex[tool] ?? 0
      callIndex[tool] = index + 1
      const value = options.handler(tool, args, index)
      if (value === null) throw new Error(`mock ${tool} failure`)
      return { stdout: value, stderr: '' }
    }
  }
}

function validEvidence(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 4444,
    controllerPort: 63001,
    mixedPort: 63002,
    workspace: '/tmp/mihomo-real-xxxx',
    configDir: '/tmp/mihomo-real-xxxx/config',
    binaryPath: 'C:\\tools\\mihomo.exe',
    version: '1.19.30',
    versionOk: true,
    controllerHost: '127.0.0.1',
    mixedHost: '127.0.0.1',
    networkDiffPASS: true,
    ...overrides
  })
}

let cleanupDirs: string[] = []

async function withEvidence(content: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cleanup-ev-'))
  cleanupDirs.push(dir)
  const path = join(dir, 'evidence.json')
  await writeFile(path, content, 'utf8')
  await fn(path)
}

/** A runner whose recorded PID stays "alive" until the probe actually kills it. */
function pidGuard(recordedPid: number, ...extraAlive: number[]) {
  const killed = new Set<number>()
  const pidAlive = (pid: number) => [recordedPid, ...extraAlive].includes(pid) && !killed.has(pid)
  const markKilled = (tool: string, args: string[]) => {
    if (tool === 'taskkill') {
      const pidArg = args[args.indexOf('/PID') + 1]
      if (pidArg) killed.add(Number(pidArg))
    }
  }
  return { pidAlive, markKilled, killed }
}

afterEach(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  cleanupDirs = []
})

describe('cleanupKernel — fail-closed evidence & probes', () => {
  it('require-evidence: missing evidence file fails closed after reaping residual mihomo', async () => {
    const logs: string[] = []
    // No evidence file at all; a stateful probe first reports residual mihomo 7777
    // then clean, so we can prove the residual was still reaped before the fail.
    const probe: { first: boolean } = { first: true }
    const runner2 = makeRunner({
      isWin: true,
      pidAlive: () => true,
      handler: (tool, args) => {
        if (tool === 'tasklist') {
          if (args.includes('/FI')) return tasklistCsv([['mihomo.exe', 9999]])
          if (probe.first) {
            probe.first = false
            return tasklistCsv([['mihomo.exe', 7777]])
          }
          return tasklistCsv([])
        }
        if (tool === 'taskkill') return ''
        throw new Error(`unexpected tool ${tool}`)
      }
    })
    await expect(
      cleanupKernel('/nonexistent/cleanup-evidence.json', {
        requireEvidence: true,
        runner: runner2,
        log: (m) => logs.push(m)
      })
    ).rejects.toThrow(/missing or unreadable/)
    // Residual mihomo was enumerated and terminated before the evidence error.
    expect(runner2.calls.some((c) => c.tool === 'taskkill' && c.args.includes('7777'))).toBe(true)
    expect(logs.some((l) => l.includes('no mihomo process remains'))).toBe(true)
    expect(logs.some((l) => l.includes('kernel watchdog: PASS'))).toBe(false)
  })

  it('require-evidence: corrupt evidence file fails closed', async () => {
    await withEvidence('{ definitely not json', async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      await expect(
        cleanupKernel(path, { requireEvidence: true, runner, log: () => undefined })
      ).rejects.toThrow(/missing or unreadable/)
    })
  })

  it('require-evidence: field-incomplete evidence fails closed (naming the missing field)', async () => {
    await withEvidence(JSON.stringify({ pid: 1, controllerPort: 3 }), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      await expect(
        cleanupKernel(path, { requireEvidence: true, runner, log: () => undefined })
      ).rejects.toThrow(/incomplete; missing required field\(s\): mixedPort, workspace, configDir/)
    })
  })

  it('without require-evidence, a missing evidence file resolves as "no-evidence", NOT cleaned/PASS', async () => {
    const logs: string[] = []
    const runner = makeRunner({
      isWin: true,
      pidAlive: () => false,
      handler: (tool) => {
        if (tool === 'tasklist') return tasklistCsv([])
        throw new Error(`unexpected tool ${tool}`)
      }
    })
    const result = await cleanupKernel('/nonexistent/cleanup-evidence.json', {
      runner,
      log: (m) => logs.push(m)
    })
    expect(result.action).toBe('no-evidence')
    expect(result.verified).toBe(false)
    expect(result.pid).toBe(0)
    expect(logs.some((l) => l.includes('kernel watchdog: PASS'))).toBe(false)
  })

  it('process probe command failure fails the run (cannot report "no mihomo")', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return null // tasklist crashes
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      await expect(cleanupKernel(path, { runner, log: () => undefined })).rejects.toThrow(
        /process probe failed \(tasklist\)/
      )
    })
  })

  it('blank process probe output fails the run', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return '   \n \n'
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      await expect(cleanupKernel(path, { runner, log: () => undefined })).rejects.toThrow(
        /returned no parseable output; cannot prove no residual mihomo/
      )
    })
  })

  it('malformed process probe output fails the run', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return '"mihomo.exe","not-a-pid",...' // pid is not a number
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      await expect(cleanupKernel(path, { runner, log: () => undefined })).rejects.toThrow(
        /tasklist process probe output unparseable row/
      )
    })
  })

  it('listener probe command failure fails the run', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          if (tool === 'netstat') return null // netstat crashes
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      await expect(cleanupKernel(path, { runner, log: () => undefined })).rejects.toThrow(
        /listener probe failed \(netstat\)/
      )
    })
  })

  it('blank listener probe output fails the run', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          if (tool === 'netstat') return ' \n  \n'
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      await expect(cleanupKernel(path, { runner, log: () => undefined })).rejects.toThrow(
        /returned no parseable output; cannot prove port 63001 released/
      )
    })
  })

  it('LISTENING rows with no parseable address fail the run (unparseable != released)', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          if (tool === 'netstat') return '  TCP    ???    0.0.0.0:0    LISTENING    1234'
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      await expect(cleanupKernel(path, { runner, log: () => undefined })).rejects.toThrow(
        /listener probe output unparseable \(saw LISTENING rows but no host:port\)/
      )
    })
  })

  it('normal case: no residual mihomo and ports released results in a cleaned PASS', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const logs: string[] = []
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([['svchost.exe', 1234]])
          if (tool === 'netstat') return netstatOut([['127.0.0.1', 9999]]) // only an unrelated listener
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      const result = await cleanupKernel(path, { runner, log: (m) => logs.push(m) })
      expect(result.action).toBe('cleaned')
      expect(result.verified).toBe(true)
      expect(result.pid).toBe(4444)
      expect(logs.some((l) => l.includes('kernel watchdog: PASS'))).toBe(true)
    })
  })
})

describe('cleanupKernel — recorded-PID identity / PID-reuse protection', () => {
  it('never kills a recorded PID whose identity is NOT mihomo (recycled PID)', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const logs: string[] = []
      const guard = pidGuard(4444)
      const runner = makeRunner({
        isWin: true,
        pidAlive: guard.pidAlive,
        handler: (tool, args) => {
          if (tool === 'tasklist') {
            if (args.includes('/FI')) return tasklistCsv([['node.exe', 4444]]) // matched row is node
            return tasklistCsv([['node.exe', 4444], ['svchost.exe', 100]])
          }
          if (tool === 'netstat') return netstatOut([])
          if (tool === 'taskkill') return ''
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      const result = await cleanupKernel(path, { runner, log: (m) => logs.push(m) })
      expect(result.action).toBe('cleaned')
      // The unrelated runner process was NOT signalled.
      expect(runner.calls.some((c) => c.tool === 'taskkill' && c.args.includes('4444'))).toBe(false)
      expect(logs.some((l) => l.includes('refusing to terminate (stale/reused PID)'))).toBe(true)
    })
  })

  it('still reaps a residual mihomo that is NOT the (reused) recorded PID', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const guard = pidGuard(4444, 999)
      let probeCount = 0
      const runner = makeRunner({
        isWin: true,
        pidAlive: guard.pidAlive,
        handler: (tool, args) => {
          if (tool === 'taskkill') {
            guard.markKilled(tool, args)
            return ''
          }
          if (tool === 'tasklist') {
            if (args.includes('/FI')) return tasklistCsv([['node.exe', 4444]]) // reused -> node
            probeCount++
            return probeCount === 1 ? tasklistCsv([['mihomo.exe', 999]]) : tasklistCsv([])
          }
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      const result = await cleanupKernel(path, { runner, log: () => undefined })
      expect(result.action).toBe('cleaned')
      expect(runner.calls.some((c) => c.tool === 'taskkill' && c.args.includes('999'))).toBe(true)
    })
  })

  it('kills the recorded PID when its identity IS mihomo and matches the binary path', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const guard = pidGuard(4444)
      const logs: string[] = []
      const runner = makeRunner({
        isWin: true,
        pidAlive: guard.pidAlive,
        handler: (tool, args) => {
          if (tool === 'taskkill') {
            guard.markKilled(tool, args)
            return ''
          }
          if (tool === 'tasklist') {
            if (args.includes('/FI')) return tasklistCsv([['mihomo.exe', 4444]])
            return tasklistCsv([])
          }
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected tool ${tool}`)
        }
      })
      const result = await cleanupKernel(path, { runner, log: (m) => logs.push(m) })
      expect(result.action).toBe('cleaned')
      expect(runner.calls.some((c) => c.tool === 'taskkill' && c.args.includes('4444'))).toBe(true)
      expect(logs.some((l) => l.includes('stopping recorded PID 4444'))).toBe(true)
    })
  })
})

describe('cleanupKernel — probe helper contracts', () => {
  it('isMihomoName accepts only mihomo/mihomo.exe', () => {
    expect(isMihomoName('mihomo.exe')).toBe(true)
    expect(isMihomoName('Mihomo.EXE')).toBe(true)
    expect(isMihomoName('mihomo')).toBe(true)
    expect(isMihomoName('node.exe')).toBe(false)
    expect(isMihomoName('')).toBe(false)
    expect(isMihomoName(null as unknown as string)).toBe(false)
  })

  it('binaryPathMatchesName compares normalized basenames', () => {
    expect(binaryPathMatchesName('C:\\tools\\mihomo.exe', 'mihomo.exe')).toBe(true)
    expect(binaryPathMatchesName('/opt/mihomo/mihomo', 'mihomo')).toBe(true)
    expect(binaryPathMatchesName('C:\\tools\\mihomo.exe', 'node.exe')).toBe(false)
    expect(binaryPathMatchesName('', 'mihomo.exe')).toBe(false)
  })

  it('mihomoPids throws when the probe command fails', async () => {
    const runner = makeRunner({
      isWin: true,
      handler: (tool) => {
        if (tool === 'tasklist') return null
        throw new Error('unexpected')
      }
    })
    await expect(mihomoPids(runner)).rejects.toThrow(/process probe failed \(tasklist\)/)
  })

  it('mihomoPids skips a healthy PID-0 system row (System Idle Process) instead of failing', async () => {
    // A real `tasklist` dump always carries system pseudo-process rows (PID 0,
    // PID 4) and a "Mem Usage" column containing a thousands-separator comma.
    // These must NOT be mistaken for unparseable output.
    const dump = [
      '"System Idle Process","0","Services","0","8 K"',
      '"System","4","Services","0","196 K"',
      '"mihomo.exe","8899","Console","1","3,104 K"',
      '"svchost.exe","1234","Services","0","20,000 K"'
    ].join('\r\n')
    const runner = makeRunner({
      isWin: true,
      handler: (tool) => {
        if (tool === 'tasklist') return dump
        throw new Error('unexpected')
      }
    })
    await expect(mihomoPids(runner)).resolves.toEqual([8899])
  })

  it('portHasListener reports a matching listener as not released', async () => {
    const runner = makeRunner({
      isWin: true,
      handler: (tool) => {
        if (tool === 'netstat') return netstatOut([['127.0.0.1', 63001]])
        throw new Error('unexpected')
      }
    })
    await expect(portHasListener(63001, runner)).resolves.toBe(true)
    await expect(portHasListener(99999, runner)).resolves.toBe(false)
  })
})

describe('cleanupKernel — Unix (ps/ss) probe path', () => {
  it('ps: suppresses a header and reports only mihomo rows', async () => {
    const runner = makeRunner({
      isWin: false,
      handler: (tool) => {
        if (tool === 'ps') return '    PID COMMAND\n      1 systemd\n   1234 mihomo\n   5678 node'
        throw new Error('unexpected')
      }
    })
    await expect(mihomoPids(runner)).resolves.toEqual([1234])
  })

  it('ps: header-only output fails closed (no parseable process rows)', async () => {
    const runner = makeRunner({
      isWin: false,
      handler: (tool) => {
        if (tool === 'ps') return '    PID COMMAND\n'
        throw new Error('unexpected')
      }
    })
    await expect(mihomoPids(runner)).rejects.toThrow(/returned no parseable process rows/)
  })

  it('ss: reports a matching LISTEN address on the target port', async () => {
    const runner = makeRunner({
      isWin: false,
      handler: (tool) => {
        if (tool === 'ss') {
          return 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 128 127.0.0.1:63001 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:44411 0.0.0.0:*'
        }
        throw new Error('unexpected')
      }
    })
    await expect(portHasListener(63001, runner)).resolves.toBe(true)
    await expect(portHasListener(44411, runner)).resolves.toBe(true)
    await expect(portHasListener(999, runner)).resolves.toBe(false)
  })

  it('ss: blank output fails closed', async () => {
    const runner = makeRunner({
      isWin: false,
      handler: (tool) => {
        if (tool === 'ss') return '   '
        throw new Error('unexpected')
      }
    })
    await expect(portHasListener(63001, runner)).rejects.toThrow(/returned no parseable output/)
  })
})
