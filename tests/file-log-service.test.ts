import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileLogService } from '../src/main/logging/file-log-service'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'file-logs-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileLogService', () => {
  it('redacts credentials and compacts a busy daily file below its hard cap', async () => {
    const root = await tempRoot()
    const now = new Date('2026-09-07T12:00:00.000Z')
    const logs = new FileLogService(root, { maxFileBytes: 1024, now: () => now })
    await logs.writeApp('info', ['Authorization: Bearer top-secret', 'token=hidden'])
    for (let index = 0; index < 30; index++) {
      await logs.writeApp('info', [`entry-${index}`, 'x'.repeat(80)])
    }
    await logs.flush()

    const file = logs.pathFor('app')
    expect((await stat(file)).size).toBeLessThanOrEqual(1024)
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('top-secret')
    expect(text).not.toContain('token=hidden')
    expect(text).toContain('entry-29')
    expect(text).toContain('size limit was reached')
  })

  it('rotates by day and removes only recognized expired log files', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'app-2026-08-01.log'), 'old')
    await writeFile(join(root, 'notes-2026-08-01.log'), 'keep')
    let now = new Date('2026-09-07T12:00:00.000Z')
    const logs = new FileLogService(root, { retentionDays: 7, now: () => now })
    await logs.initialize()
    await expect(stat(join(root, 'app-2026-08-01.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'notes-2026-08-01.log'), 'utf8')).resolves.toBe('keep')

    await logs.writeCore({ type: 'info', payload: 'first day' })
    now = new Date('2026-09-08T12:00:00.000Z')
    await logs.writeCore({ type: 'warning', payload: 'second day' })
    await logs.flush()
    await expect(readFile(join(root, 'core-2026-09-07.log'), 'utf8')).resolves.toContain('first day')
    await expect(readFile(join(root, 'core-2026-09-08.log'), 'utf8')).resolves.toContain('second day')
  })

  it('masks an unlabelled fixed-width controller secret', async () => {
    const root = await tempRoot()
    const logs = new FileLogService(root, { now: () => new Date('2026-09-07T12:00:00.000Z') })
    const secret = 'a'.repeat(64)
    await logs.writeCore({ type: 'error', payload: `controller rejected ${secret}` })
    await logs.flush()
    const text = await readFile(logs.pathFor('core'), 'utf8')
    expect(text).not.toContain(secret)
    expect(text).toContain('[REDACTED]')
  })
})
