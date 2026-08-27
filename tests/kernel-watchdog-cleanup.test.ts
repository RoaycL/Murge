import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, access, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Load the shared cleanup script at runtime rather than via a static top-level
// `import ... from '...mjs'`: vitest's Windows transform chokes on a static
// `.mjs` import in a `.test.ts` module (observed on the kernel-real-windows CI
// job as `SyntaxError: Invalid or unexpected token` at the import site), while a
// dynamic `import()` of the same `.mjs` is handled fine cross-platform.
type CleanupScript = typeof import('../scripts/kernel-watchdog-cleanup.mjs')
let cleanupKernel: CleanupScript['cleanupKernel']
let isMihomoName: CleanupScript['isMihomoName']
let binaryPathMatchesName: CleanupScript['binaryPathMatchesName']
let mihomoPids: CleanupScript['mihomoPids']
let portHasListener: CleanupScript['portHasListener']
let validateEvidenceSchema: CleanupScript['validateEvidenceSchema']
let validateEvidencePaths: CleanupScript['validateEvidencePaths']

beforeAll(async () => {
  const mod = await import('../scripts/kernel-watchdog-cleanup.mjs')
  cleanupKernel = mod.cleanupKernel
  isMihomoName = mod.isMihomoName
  binaryPathMatchesName = mod.binaryPathMatchesName
  mihomoPids = mod.mihomoPids
  portHasListener = mod.portHasListener
  validateEvidenceSchema = mod.validateEvidenceSchema
  validateEvidencePaths = mod.validateEvidencePaths
})

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

describe('validateEvidenceSchema — strict schema & path ownership', () => {
  it('rejects a pid that is not a positive integer', () => {
    const base = JSON.parse(validEvidence())
    for (const bad of ['abc', -1, 0, 1.5, null, undefined, '']) {
      const problems = validateEvidenceSchema({ ...base, pid: bad })
      expect(problems.some((p) => p.startsWith('pid must be a positive integer'))).toBe(true)
    }
  })

  it('rejects out-of-range / non-integer ports and unequal requirement', () => {
    const base = JSON.parse(validEvidence())
    for (const [field, value] of [
      ['controllerPort', 0],
      ['controllerPort', 1000],
      ['controllerPort', 70000],
      ['controllerPort', 'abc'],
      ['controllerPort', null],
      ['mixedPort', 1]
    ] as Array<[string, unknown]>) {
      const problems = validateEvidenceSchema({
        ...base,
        [field]: value,
        mixedPort: field === 'mixedPort' ? value : base.mixedPort
      })
      expect(problems.some((p) => p.includes(`${field} must be an integer in 1024-65535`))).toBe(true)
    }
    const equal = validateEvidenceSchema({ ...base, controllerPort: 63001, mixedPort: 63001 })
    expect(equal.some((p) => p.includes('must be different ports'))).toBe(true)
  })

  it('rejects a workspace that is relative, a filesystem root, or a wrong prefix', () => {
    const base = JSON.parse(validEvidence())
    expect(
      validateEvidenceSchema({ ...base, workspace: 'mihomo-real-x' }).some((p) => p.includes('absolute path'))
    ).toBe(true)
    expect(
      validateEvidenceSchema({ ...base, workspace: '/' }).some((p) => p.includes('filesystem root'))
    ).toBe(true)
    expect(
      validateEvidenceSchema({ ...base, workspace: '/tmp/mihomo-ui-x' }).some((p) => p.includes('workspace basename'))
    ).toBe(true)
  })

  it('rejects `..` segments and a configDir escaping or outside the workspace', () => {
    const base = JSON.parse(validEvidence())
    expect(
      validateEvidenceSchema({ ...base, workspace: '/tmp/mihomo-real-x/../mihomo-real-y' }).some((p) =>
        p.includes("'..'")
      )
    ).toBe(true)
    expect(
      validateEvidenceSchema({ ...base, workspace: '/tmp/mihomo-real-x' }).some((p) => p.includes("'..'"))
    ).toBe(false)
    expect(
      validateEvidenceSchema({ ...base, configDir: '/tmp/mihomo-real-other/config' }).some((p) =>
        p.includes('within workspace')
      )
    ).toBe(true)
    expect(
      validateEvidenceSchema({ ...base, configDir: '/tmp/mihomo-real-xxxx/../config' }).some((p) =>
        p.includes("'..'")
      )
    ).toBe(true)
    expect(
      validateEvidenceSchema({ ...base, configDir: 'config' }).some((p) => p.includes('absolute path'))
    ).toBe(true)
  })

  it('accepts a fully valid document and enforces allowedWorkspaceRoots containment', () => {
    const base = JSON.parse(validEvidence())
    expect(validateEvidenceSchema(base)).toEqual([])
    expect(validateEvidenceSchema(base, { allowedWorkspaceRoots: ['/tmp'] })).toEqual([])
    expect(
      validateEvidenceSchema(base, { allowedWorkspaceRoots: ['/definitely/not/allowed'] }).some((p) =>
        p.includes('outside allowed roots')
      )
    ).toBe(true)
  })
})

describe('strict mihomo naming & binaryPath mismatch', () => {
  it('Windows tasklist: enumerates ONLY exact mihomo/mihomo.exe, never approximate names', async () => {
    const dump = tasklistCsv([
      ['mihomo.exe', 100],
      ['mihomo', 200],
      ['Mihomo.EXE', 700],
      ['mihomo-helper.exe', 300],
      ['mihomo-ui.exe', 400],
      ['mihomo.old', 500],
      ['not-mihomo', 600]
    ])
    const runner = makeRunner({
      isWin: true,
      handler: (tool) => (tool === 'tasklist' ? dump : (() => { throw new Error('unexpected') })())
    })
    await expect(mihomoPids(runner)).resolves.toEqual([100, 200, 700])
  })

  it('Unix ps: enumerates ONLY exact mihomo, never approximate names', async () => {
    const runner = makeRunner({
      isWin: false,
      handler: (tool) =>
        tool === 'ps'
          ? '1235 mihomo\n900 mihomo-helper\n901 mihomo.old\n902 not-mihomo\n610 mihomo\n'
          : (() => { throw new Error('unexpected') })()
    })
    await expect(mihomoPids(runner)).resolves.toEqual([1235, 610])
  })

  it('cleanupKernel never signals a process whose name merely approximates mihomo', async () => {
    await withEvidence(validEvidence(), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool, args) => {
          if (tool === 'tasklist') {
            return tasklistCsv([
              ['mihomo-helper.exe', 300],
              ['mihomo-ui.exe', 400],
              ['mihomo.old', 500],
              ['not-mihomo', 600]
            ])
          }
          if (tool === 'netstat') return netstatOut([])
          if (tool === 'taskkill') return ''
          throw new Error(`unexpected ${tool}`)
        }
      })
      const result = await cleanupKernel(path, { runner, log: () => undefined })
      expect(result.action).toBe('cleaned')
      expect(runner.calls.filter((c) => c.tool === 'taskkill')).toEqual([])
    })
  })

  it('refuses to kill the recorded PID when binaryPath basename does not match the observed process', async () => {
    await withEvidence(validEvidence({ binaryPath: 'C:\\tools\\evil.exe' }), async (path) => {
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
            return tasklistCsv([['svchost.exe', 100]])
          }
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected ${tool}`)
        }
      })
      const result = await cleanupKernel(path, { runner, log: (m) => logs.push(m) })
      expect(result.action).toBe('cleaned')
      expect(runner.calls.some((c) => c.tool === 'taskkill' && c.args.includes('4444'))).toBe(false)
      expect(logs.some((l) => l.includes('refusing to terminate (stale/reused PID)'))).toBe(true)
      expect(logs.some((l) => l.includes('stopping recorded PID 4444'))).toBe(false)
    })
  })
})

describe('path-escape evidence must never reach rm', () => {
  it('still sweeps residual mihomo by exact name, then fails require-evidence on a `..` workspace', async () => {
    const ev = JSON.parse(
      validEvidence({ workspace: '/tmp/mihomo-real-x/../bad', configDir: '/tmp/mihomo-real-x/config' })
    )
    await withEvidence(JSON.stringify(ev), async (path) => {
      const guard = pidGuard(999)
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
            probeCount++
            return probeCount === 1
              ? tasklistCsv([['mihomo.exe', 999], ['mihomo-helper.exe', 300]])
              : tasklistCsv([])
          }
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected ${tool}`)
        }
      })
      await expect(cleanupKernel(path, { requireEvidence: true, runner })).rejects.toThrow()
      expect(runner.calls.some((c) => c.tool === 'taskkill' && c.args.includes('999'))).toBe(true)
      expect(runner.calls.some((c) => c.tool === 'taskkill' && c.args.includes('300'))).toBe(false)
    })
  })

  it('never removes a directory when the workspace is outside allowedWorkspaceRoots', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mihomo-real-'))
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'keep me', 'utf8')
    cleanupDirs.push(outside)
    const ev = JSON.parse(validEvidence({ workspace: outside, configDir: join(outside, 'config') }))
    await withEvidence(JSON.stringify(ev), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected ${tool}`)
        }
      })
      await expect(
        cleanupKernel(path, {
          requireEvidence: true,
          runner,
          allowedWorkspaceRoots: ['/definitely/not/allowed']
        })
      ).rejects.toThrow(/outside allowed roots/)
      await expect(access(sentinel)).resolves.toBeUndefined()
    })
  })
})

describe('validateEvidencePaths — lstat/realpath escape protection', () => {
  it('accepts a workspace/configDir that does not exist (ENOENT; nothing to delete)', async () => {
    const missingWs = join(tmpdir(), 'mihomo-real-zzz')
    expect(await validateEvidencePaths({ workspace: missingWs, configDir: join(missingWs, 'config') })).toEqual([])
  })

  it('rejects a workspace that is a symbolic link/junction out of the allowed root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mihomo-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'mihomo-real-'))
    cleanupDirs.push(root, outside)
    const wsLink = join(root, 'mihomo-real-esc')
    await symlink(outside, wsLink, 'junction')
    const problems = await validateEvidencePaths(
      { workspace: wsLink, configDir: join(wsLink, 'config') },
      { allowedWorkspaceRoots: [root] }
    )
    expect(problems.some((p) => p.includes('workspace is a symbolic link'))).toBe(true)
  })

  it('rejects a configDir that is a symbolic link/junction out of the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mihomo-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'mihomo-real-'))
    cleanupDirs.push(root, outside)
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfgLink = join(ws, 'config')
    await symlink(outside, cfgLink, 'junction')
    const problems = await validateEvidencePaths(
      { workspace: ws, configDir: cfgLink },
      { allowedWorkspaceRoots: [root] }
    )
    expect(problems.some((p) => p.includes('configDir is a symbolic link'))).toBe(true)
  })

  it('rejects a real workspace whose realpath resolves outside the allowed roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mihomo-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'mihomo-real-'))
    cleanupDirs.push(root, outside)
    const problems = await validateEvidencePaths(
      { workspace: outside, configDir: join(outside, 'config') },
      { allowedWorkspaceRoots: [root] }
    )
    expect(problems.some((p) => p.includes('outside allowed roots'))).toBe(true)
  })

  it('accepts a real workspace and its config dir inside an allowed root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mihomo-root-'))
    cleanupDirs.push(root)
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfg = join(ws, 'config')
    await mkdir(cfg, { recursive: true })
    expect(await validateEvidencePaths({ workspace: ws, configDir: cfg }, { allowedWorkspaceRoots: [root] })).toEqual(
      []
    )
  })
})

describe('cleanupKernel — never descends a symlink/junction into a wider rm scope', () => {
  it('fails require-evidence and preserves the external target of a symlinked workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mihomo-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'mihomo-real-'))
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'keep me', 'utf8')
    cleanupDirs.push(root, outside)
    const wsLink = join(root, 'mihomo-real-esc')
    await symlink(outside, wsLink, 'junction')
    const ev = JSON.parse(validEvidence({ workspace: wsLink, configDir: join(wsLink, 'config') }))
    await withEvidence(JSON.stringify(ev), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected ${tool}`)
        }
      })
      await expect(
        cleanupKernel(path, { requireEvidence: true, runner, allowedWorkspaceRoots: [root] })
      ).rejects.toThrow(/workspace is a symbolic link|workspace real path/)
      await expect(access(sentinel)).resolves.toBeUndefined()
    })
  })

  it('fails require-evidence and preserves the external target of a symlinked configDir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mihomo-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'mihomo-real-'))
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'keep me', 'utf8')
    cleanupDirs.push(root, outside)
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfgLink = join(ws, 'config')
    await symlink(outside, cfgLink, 'junction')
    const ev = JSON.parse(validEvidence({ workspace: ws, configDir: cfgLink }))
    await withEvidence(JSON.stringify(ev), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected ${tool}`)
        }
      })
      await expect(
        cleanupKernel(path, { requireEvidence: true, runner, allowedWorkspaceRoots: [root] })
      ).rejects.toThrow(/configDir is a symbolic link|configDir real path/)
      await expect(access(sentinel)).resolves.toBeUndefined()
    })
  })

  it('removes only the link of a mihomo-workspace-* symlink child, preserving its external target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mihomo-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'mihomo-real-'))
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'keep me', 'utf8')
    cleanupDirs.push(root, outside)
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfg = join(ws, 'config')
    await mkdir(cfg, { recursive: true })
    const childLink = join(cfg, 'mihomo-workspace-evil')
    await symlink(outside, childLink, 'junction')
    const ev = JSON.parse(validEvidence({ workspace: ws, configDir: cfg }))
    await withEvidence(JSON.stringify(ev), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected ${tool}`)
        }
      })
      const result = await cleanupKernel(path, { requireEvidence: true, runner, allowedWorkspaceRoots: [root] })
      expect(result.action).toBe('cleaned')
      // The workspace was cleaned and the child link is gone ...
      await expect(access(ws)).rejects.toThrow()
      // ... but the external directory the link pointed at was never touched.
      await expect(access(sentinel)).resolves.toBeUndefined()
    })
  })

  it('still cleans a normal real workspace (no symlinks) end to end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mihomo-root-'))
    cleanupDirs.push(root)
    const ws = await mkdtemp(join(root, 'mihomo-real-'))
    const cfg = join(ws, 'config')
    await mkdir(cfg, { recursive: true })
    const child = join(cfg, 'mihomo-workspace-normal')
    await mkdir(child, { recursive: true })
    await writeFile(join(child, 'store.json'), '{}', 'utf8')
    const ev = JSON.parse(validEvidence({ workspace: ws, configDir: cfg }))
    await withEvidence(JSON.stringify(ev), async (path) => {
      const runner = makeRunner({
        isWin: true,
        pidAlive: () => false,
        handler: (tool) => {
          if (tool === 'tasklist') return tasklistCsv([])
          if (tool === 'netstat') return netstatOut([])
          throw new Error(`unexpected ${tool}`)
        }
      })
      const result = await cleanupKernel(path, { requireEvidence: true, runner, allowedWorkspaceRoots: [root] })
      expect(result.action).toBe('cleaned')
      expect(result.verified).toBe(true)
      await expect(access(ws)).rejects.toThrow()
    })
  })
})
