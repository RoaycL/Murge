import { describe, it, expect } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MihomoKernelConfigStore } from '../src/main/kernel/mihomo-config-store'
import { validateMihomoConfigYaml } from '../src/main/kernel/mihomo-config'

const secret = 'b'.repeat(32)

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
})
