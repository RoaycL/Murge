import { describe, it, expect } from 'vitest'
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MihomoKernelConfigStore } from '../src/main/kernel/mihomo-config-store'
import { validateMihomoConfigYaml } from '../src/main/kernel/mihomo-config'

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
    expect(text).toContain(`secret: ${secret}`)

    await store.cleanup(config)
    await expect(stat(config.rootDir)).rejects.toThrow()
  })

  it('uses a generated secret when none is provided', async () => {
    const store = new MihomoKernelConfigStore({ mixedPort: 22000, controllerPort: 22001 })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] })
    const text = await readFile(config.configPath, 'utf8')
    const match = text.match(/^secret: (.+)$/m)
    expect(match).not.toBeNull()
    expect(match![1]).toMatch(/^[0-9a-f]{64}$/)
    await store.cleanup(config)
  })

  it('replaces a non-conforming caller secret with a fresh one (injection guard)', async () => {
    const store = new MihomoKernelConfigStore({ mixedPort: 22500, controllerPort: 22501 })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] }, 'short')
    const text = await readFile(config.configPath, 'utf8')
    // A short/attacker secret must never be written through.
    expect(text).not.toContain('secret: short')
    const match = text.match(/^secret: (.+)$/m)
    expect(match![1]).toMatch(/^[0-9a-f]{64}$/)
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
