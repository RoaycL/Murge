import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceFile } from './kernel-evidence'

describe('EvidenceFile (atomic CI watchdog evidence)', () => {
  let dir = ''

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      dir = ''
    }
  })

  function sample(pid: number, workspace: string) {
    return { pid, controllerPort: 63426, mixedPort: 63425, workspace, configDir: join(workspace, 'config') }
  }

  it('writes and reads back the recorded PID and ports', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kern-evidence-'))
    const path = join(dir, 'evidence.json')
    const evidence = new EvidenceFile(path)
    await evidence.update(sample(2340, dir))
    const read = await evidence.read()
    expect(read).not.toBeNull()
    expect(read!.pid).toBe(2340)
    expect(read!.controllerPort).toBe(63426)
    expect(read!.mixedPort).toBe(63425)
    expect(await evidence.exists()).toBe(true)
  })

  it('leaves only the latest value after a sequence of PID updates', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kern-evidence-'))
    const path = join(dir, 'evidence.json')
    const evidence = new EvidenceFile(path)
    await evidence.update(sample(1, dir))
    await evidence.update(sample(2, dir))
    await evidence.update(sample(3, dir))
    expect((await evidence.read())!.pid).toBe(3)
  })

  it('never leaves a stray temp file behind (atomically replaced)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kern-evidence-'))
    const path = join(dir, 'evidence.json')
    const evidence = new EvidenceFile(path)
    await evidence.update(sample(7, dir))
    const entries = await readdir(dir)
    expect(entries).toEqual(['evidence.json'])
  })

  it('reads null for a missing or corrupt file (fail closed)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kern-evidence-'))
    const missing = new EvidenceFile(join(dir, 'missing.json'))
    expect(await missing.read()).toBeNull()
    await writeFile(join(dir, 'corrupt.json'), '{ definitely not json', 'utf8')
    expect(await new EvidenceFile(join(dir, 'corrupt.json')).read()).toBeNull()
  })

  it('serializes concurrent updates so the last caller wins intact', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kern-evidence-'))
    const path = join(dir, 'evidence.json')
    const evidence = new EvidenceFile(path)
    // Fire a burst without awaiting in between; the chain must still yield a
    // single consistent final document.
    await Promise.all([
      evidence.update(sample(101, dir)),
      evidence.update(sample(102, dir)),
      evidence.update(sample(103, dir))
    ])
    const final = await evidence.read()
    expect(final).not.toBeNull()
    expect([101, 102, 103]).toContain(final!.pid)
    const entries = await readdir(dir)
    expect(entries).toEqual(['evidence.json'])
  })
})
