import { describe, it, expect } from 'vitest'
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MihomoKernelConfigStore } from '../src/main/kernel/mihomo-config-store'
import { validateMihomoConfigYaml } from '../src/main/kernel/mihomo-config'
import { ProtocolErrorCode } from '@shared/protocol-errors'

const secret = 'b'.repeat(64)

describe('MihomoKernelConfigStore', () => {
  it('materializes a strict config and tracks the workspace for cleanup', async () => {
    const store = new MihomoKernelConfigStore({ mixedPort: 21000, controllerPort: 21001 })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] }, secret)
    expect(config.rootDir).toContain('mihomo-workspace-')
    expect(config.configPath).toBe(join(config.rootDir, 'config.yaml'))
    expect(config.args).toEqual(['-f', config.configPath, '-d', config.rootDir])

    const text = await readFile(config.configPath, 'utf8')
    expect(() => validateMihomoConfigYaml(text)).not.toThrow()
    expect(text).toContain(`mixed-port: 21000`)
    expect(text).toContain(`external-controller: 127.0.0.1:21001`)
    // The caller's secret must be written through verbatim — the store must not
    // mint its own, or the config auth would diverge from the client auth.
    expect(text).toContain(`secret: ${secret}`)

    await store.cleanup(config)
    await expect(stat(config.rootDir)).rejects.toThrow()
  })

  it('fails closed when materialize is called without any secret', async () => {
    const store = new MihomoKernelConfigStore({ mixedPort: 22000, controllerPort: 22001 })
    await expect(
      store.materialize({ command: '/bin/mihomo', args: [] }, '')
    ).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
  })

  it('fails closed on a non-conforming caller secret instead of silently replacing it', async () => {
    const store = new MihomoKernelConfigStore({ mixedPort: 22500, controllerPort: 22501 })
    // A short/attacker secret must never be accepted NOR silently replaced with a
    // fresh one: an invalid explicit secret is a programming error between the
    // composition root, the config store and the client.
    await expect(
      store.materialize({ command: '/bin/mihomo', args: [] }, 'short')
    ).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
  })

  it('reflects the exact caller secret in the written config document', async () => {
    const callerSecret = 'c'.repeat(64)
    const store = new MihomoKernelConfigStore({ mixedPort: 22600, controllerPort: 22601 })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] }, callerSecret)
    const text = await readFile(config.configPath, 'utf8')
    const match = text.match(/^secret: (.+)$/m)
    expect(match).not.toBeNull()
    expect(match![1]).toBe(callerSecret)
    await store.cleanup(config)
  })

  it('treats workspaceDir as a parent and only cleans up its exact child', async () => {
    const parent = join(tmpdir(), `mihomo-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(parent, { recursive: true })
    await writeFile(join(parent, 'keep.txt'), 'caller-owned file, must survive')

    const store = new MihomoKernelConfigStore({
      mixedPort: 23000,
      controllerPort: 23001,
      workspaceDir: parent
    })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] }, secret)

    // The store nested its own runtime dir beneath the caller's parent.
    expect(config.rootDir.startsWith(parent)).toBe(true)
    expect(config.rootDir).toContain('mihomo-workspace-')

    await store.cleanup(config)

    // Parent and its pre-existing files survived; only the owned child is gone.
    await expect(stat(join(parent, 'keep.txt'))).resolves.toBeTruthy()
    await expect(stat(config.rootDir)).rejects.toThrow()
    expect(await readdir(parent)).toContain('keep.txt')
  })
})
