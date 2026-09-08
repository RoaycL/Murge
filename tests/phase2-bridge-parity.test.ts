import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const read = (path: string): Promise<string> => readFile(resolve(root, path), 'utf8')
const GENERATED = 'src/renderer/src/platform/generated/desktop-api.ts'

describe('Tauri bridge parity (Phase 2)', () => {
  it('generated bridge is fresh: regenerating reproduces the committed file byte-for-byte', async () => {
    const before = await read(GENERATED)
    await run('node', ['scripts/generate-tauri-bridge.mjs'], { cwd: root })
    const after = await read(GENERATED)
    expect(after).toBe(before)
  })

  it('bridges every wire channel defined in src/shared/ipc.ts', async () => {
    const generated = await read(GENERATED)
    const ipc = await read('src/shared/ipc.ts')
    const channels = [...ipc.matchAll(/^\s{2}(\w+): '([^']+)',?$/gm)].map((m) => m[2])
    expect(channels.length).toBeGreaterThan(0)
    for (const channel of channels) {
      if (channel.endsWith('-event')) {
        expect(generated, `event channel ${channel} must be bridged`).toContain(`bridgeListen("${channel}"`)
      } else {
        expect(generated, `invoke channel ${channel} must be bridged`).toContain(`bridgeInvoke("${channel}"`)
      }
    }
  })

  it('covers the complete Phase 0 inventory surface (121 = 111 invoke + 10 events)', async () => {
    const generated = await read(GENERATED)
    const invokeChannels = [...generated.matchAll(/bridgeInvoke\("([^"]+)"/g)].map((m) => m[1])
    const eventChannels = [...generated.matchAll(/bridgeListen\("([^"]+)"/g)].map((m) => m[1])
    expect(invokeChannels).toHaveLength(111)
    expect(eventChannels).toHaveLength(10)
    expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(121)
  })

  it('dispatches through the single desktop_ipc command with positional payload arrays', async () => {
    const generated = await read(GENERATED)
    expect(generated).toContain("tauriInvoke<T>('desktop_ipc', { channel, payload: args })")
    // Arguments travel as the payload array; the names never reach the wire.
    expect(generated).toContain('getProcessIcon: (path) => bridgeInvoke("app:get-process-icon", ["path"])')
    expect(generated).toContain('set: (patch) => bridgeInvoke("app-settings:set", ["patch"])')
  })

  it('decodes ProtocolError with the shared helper (identical error mapping for both shells)', async () => {
    const generated = await read(GENERATED)
    expect(generated).toContain("import { decodeProtocolError } from '@shared/protocol-errors'")
    expect(generated).toContain('const decoded = decodeProtocolError(message)')
    expect(generated).toContain('throw decoded ?? error')
  })

  it('installs the bridge before Vue mounts in the Tauri shell', async () => {
    const main = await read('src/renderer/src/main.ts')
    expect(main).toContain('detectShell()')
    expect(main).toMatch(
      /if \(shell\.kind === 'tauri'\)[\s\S]*window\.desktop = createDesktopApi\(\)[\s\S]*mount\('#app'\)/
    )
  })
})
