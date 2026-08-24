import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { KernelConfig, KernelConfigStore } from './types'

/**
 * Materializes a runtime config into an isolated temporary workspace and cleans
 * it up afterwards.
 *
 * Safety: the written document is an innocuous fixture config — it configures
 * no proxy, no controller and no TUN/DNS — and the store refuses to delete any
 * path outside the workspace it created.
 */
export class TempKernelConfigStore implements KernelConfigStore {
  async materialize(_binary: unknown, secret: string): Promise<KernelConfig> {
    const rootDir = await mkdtemp(join(tmpdir(), 'kernel-workspace-'))
    const configPath = join(rootDir, 'config.yaml')
    // Harmless placeholder: no listener, no proxy, no TUN/DNS. The fixture
    // ignores it entirely; it exists solely to exercise write + cleanup.
    const body = `# Fixture kernel config (no listener configured)\nkernelSecret: ${secret}\n`
    await writeFile(configPath, body, 'utf8')
    return {
      configPath,
      rootDir,
      env: {
        MURGE_KERNEL_SECRET: secret,
        MURGE_KERNEL_CONFIG: configPath
      }
    }
  }

  async cleanup(config: KernelConfig): Promise<void> {
    const root = resolve(config.rootDir)
    const child = resolve(config.configPath)
    // Never delete outside the workspace this store created.
    if (child !== root && !child.startsWith(root + sep)) return
    await rm(root, { recursive: true, force: true })
  }
}
