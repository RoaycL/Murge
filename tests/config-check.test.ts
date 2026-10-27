import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkConfigWithCore } from '../src/main/kernel/config-check'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'

// A stand-in core: a node script, so the test runs on every CI host. It
// receives `-t -d <home> -f <file>` after its own script argument.
const FAKE_CORE = `
const fs = require('node:fs')
const args = process.argv.slice(2)
const file = args[args.indexOf('-f') + 1]
const text = fs.readFileSync(file, 'utf8')
if (text.includes('bad-rule')) {
  process.stderr.write('rules[0] [bad-rule] error: unsupported rule type')
  process.exit(1)
}
process.exit(0)
`

describe('checkConfigWithCore', () => {
  let root: string
  let script: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'config-check-'))
    script = join(root, 'fake-core.cjs')
    await writeFile(script, FAKE_CORE)
    await chmod(script, 0o755)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const paths = () => ({ homeDir: join(root, 'geodata'), workDir: join(root, 'validate') })
  const core = () => ({ command: process.execPath, args: [script] })

  it('accepts a document the core accepts and leaves no temporary file', async () => {
    await expect(checkConfigWithCore(core(), paths(), 'mixed-port: 7890\n')).resolves.toBeUndefined()
    expect(await readdir(paths().workDir)).toEqual([])
  })

  it('rejects with the core output as INVALID_ARGUMENT', async () => {
    const error = await checkConfigWithCore(core(), paths(), 'rules:\n  - bad-rule\n').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.INVALID_ARGUMENT)
    expect((error as ProtocolError).message).toMatch(/unsupported rule type/)
    expect(await readdir(paths().workDir)).toEqual([])
  })

  it('reports a core that cannot be run with a code that never gates a write', async () => {
    const error = await checkConfigWithCore(
      { command: join(root, 'does-not-exist'), args: [] }, paths(), 'mixed-port: 7890\n'
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(ProtocolErrorCode.KERNEL_SPAWN_FAILED)
  })
})
