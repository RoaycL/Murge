import { describe, it, expect, vi } from 'vitest'
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MihomoKernelConfigStore } from '../src/main/kernel/mihomo-config-store'
import { validateMihomoConfigYaml } from '../src/main/kernel/mihomo-config'
import { ProtocolErrorCode } from '@shared/protocol-errors'

// Wrap `writeFile` in a mock that passes through to the real implementation by
// default, so the store can be driven to fail its config write in a targeted
// test (P2: a failure after the workspace is created must clean it up). The
// default passthrough keeps every other test writing sentinel files normally.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile)
  }
})

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

  it('does not leak a workspace child when materialize fails on the secret', async () => {
    // P2: validation must happen BEFORE the per-run directory is created, so a
    // missing/malformed secret leaves no `mihomo-workspace-*` child behind.
    const parent = join(tmpdir(), `mihomo-leak-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(parent, { recursive: true })
    const store = new MihomoKernelConfigStore({
      mixedPort: 24000,
      controllerPort: 24001,
      workspaceDir: parent
    })
    await expect(
      store.materialize({ command: '/bin/mihomo', args: [] }, '')
    ).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
    await expect(
      store.materialize({ command: '/bin/mihomo', args: [] }, 'short')
    ).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
    const children = (await readdir(parent)).filter((n) => n.startsWith('mihomo-workspace-'))
    expect(children).toEqual([])
  })

  it('cleans up its own workspace child when the config write fails', async () => {
    // P2: a failure AFTER the directory is created (the config write) must make
    // the store delete exactly the child it just created before rethrowing.
    const parent = join(tmpdir(), `mihomo-writefail-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(parent, { recursive: true })
    const store = new MihomoKernelConfigStore({
      mixedPort: 24100,
      controllerPort: 24101,
      workspaceDir: parent
    })
    // Fail exactly the store's single config write; later calls (other tests'
    // sentinel files) fall through to the real implementation.
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('injected write failure'))
    await expect(
      store.materialize({ command: '/bin/mihomo', args: [] }, secret)
    ).rejects.toThrow('injected write failure')
    const children = (await readdir(parent)).filter((n) => n.startsWith('mihomo-workspace-'))
    expect(children).toEqual([])
  })

  it('preserves the caller parent and its files when materialize fails after creation', async () => {
    const parent = join(tmpdir(), `mihomo-keep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(parent, { recursive: true })
    const sentinel = join(parent, 'keep.txt')
    await writeFile(sentinel, 'caller-owned, must survive')

    const store = new MihomoKernelConfigStore({
      mixedPort: 24200,
      controllerPort: 24201,
      workspaceDir: parent
    })
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('injected write failure'))
    await expect(
      store.materialize({ command: '/bin/mihomo', args: [] }, secret)
    ).rejects.toThrow('injected write failure')

    // Parent still exists, its pre-existing file survived, and no store child remains.
    await expect(stat(sentinel)).resolves.toBeTruthy()
    expect(await readFile(sentinel, 'utf8')).toBe('caller-owned, must survive')
    expect((await readdir(parent)).filter((n) => n.startsWith('mihomo-workspace-'))).toEqual([])
  })
})

describe('MihomoKernelConfigStore (active-profile backed)', () => {
  const PROFILE = `mode: rule
proxy-providers:
  CloudCone:
    type: http
    url: https://example.com/cloud
    path: ./proxy_providers/CloudCone.yaml
proxy-groups:
  - name: 全球选择
    type: select
    proxies:
      - DIRECT
rules:
  - MATCH,漏网之鱼
tun:
  enable: true
  auto-route: true
`

  it('materializes the active profile document when a resolver returns it', async () => {
    const store = new MihomoKernelConfigStore({
      mixedPort: 25000,
      controllerPort: 25001,
      resolveActiveDocument: async () => PROFILE
    })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] }, secret)
    const text = await readFile(config.configPath, 'utf8')

    // The profile's proxies/groups/rules are carried through.
    expect(text).toContain('proxy-providers:')
    expect(text).toContain('全球选择')
    expect(text).toContain('漏网之鱼')

    // The system-mutating tun block is neutralized on the main kernel.
    expect(text).not.toMatch(/tun:/)

    // Safety keys are forced, and the caller's secret is written verbatim.
    expect(text).toContain('mixed-port: 25000')
    expect(text).toContain('external-controller: 127.0.0.1:25001')
    expect(text).toContain(`secret: ${secret}`)

    await store.cleanup(config)
  })

  it('falls back to the strict config when no active profile document exists', async () => {
    const store = new MihomoKernelConfigStore({
      mixedPort: 26000,
      controllerPort: 26001,
      resolveActiveDocument: async () => null
    })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] }, secret)
    const text = await readFile(config.configPath, 'utf8')
    // Strict path: loopback-only, direct, never mutates the host network.
    expect(() => validateMihomoConfigYaml(text)).not.toThrow()
    expect(text).toContain('MATCH,DIRECT')
    await store.cleanup(config)
  })

  it('still enforces the caller secret on the profile-backed path', async () => {
    const store = new MihomoKernelConfigStore({
      mixedPort: 27000,
      controllerPort: 27001,
      resolveActiveDocument: async () => PROFILE
    })
    await expect(
      store.materialize({ command: '/bin/mihomo', args: [] }, '')
    ).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
  })

  it('fails closed when the profile document is invalid', async () => {
    const store = new MihomoKernelConfigStore({
      mixedPort: 28000,
      controllerPort: 28001,
      resolveActiveDocument: async () => 'mode: rule\n'
    })
    // No proxies/groups/rules content → invalid => rejected before writing.
    await expect(
      store.materialize({ command: '/bin/mihomo', args: [] }, secret)
    ).rejects.toMatchObject({ code: ProtocolErrorCode.INVALID_ARGUMENT })
  })
})

describe('MihomoKernelConfigStore (persistent kernel home + geodata seed)', () => {
  it('points `-d` at the stable kernel home while the config stays in the per-run workspace', async () => {
    const parent = join(tmpdir(), `mihomo-home-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const homeDir = join(parent, 'geodata')
    const store = new MihomoKernelConfigStore({
      mixedPort: 29000,
      controllerPort: 29001,
      workspaceDir: parent,
      kernelHomeDir: homeDir
    })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] }, secret)

    // The per-run workspace still owns the config document.
    expect(config.configPath).toBe(join(config.rootDir, 'config.yaml'))
    // The kernel home argument is the STABLE directory, NOT the per-run child:
    // geodata resolved from a per-run home would be deleted on cleanup and
    // force a fresh (pre-proxy, DNS-dependent) download on every start.
    expect(config.args).toEqual(['-f', config.configPath, '-d', homeDir])
    expect(config.rootDir).not.toBe(homeDir)
    expect(config.rootDir.startsWith(parent)).toBe(true)

    await store.cleanup(config)
    // Cleanup removes the per-run config child…
    await expect(stat(config.rootDir)).rejects.toThrow()
    // …but the kernel home — and every database in it — always survives.
    await expect(stat(homeDir)).resolves.toBeTruthy()
  })

  it('seeds installer geodata into the home on first materialize', async () => {
    const parent = join(tmpdir(), `mihomo-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const resources = join(parent, 'resources-geodata')
    const homeDir = join(parent, 'geodata')
    await mkdir(resources, { recursive: true })
    await writeFile(join(resources, 'geosite.dat'), 'bundled-geosite')
    await writeFile(join(resources, 'unrelated.txt'), 'never copied')
    await writeFile(join(resources, 'geoip.metadb'), 'bundled-geoip')

    const store = new MihomoKernelConfigStore({
      mixedPort: 29100,
      controllerPort: 29101,
      workspaceDir: parent,
      kernelHomeDir: homeDir,
      seedResourcesDir: resources
    })
    const config = await store.materialize({ command: '/bin/mihomo', args: [] }, secret)

    // Only known geodata artifacts are seeded, nothing else.
    expect(await readFile(join(homeDir, 'geosite.dat'), 'utf8')).toBe('bundled-geosite')
    expect(await readFile(join(homeDir, 'geoip.metadb'), 'utf8')).toBe('bundled-geoip')
    expect(await readdir(homeDir)).not.toContain('unrelated.txt')
    await store.cleanup(config)
  })

  it('keeps a newer kept copy and never blocks startup on a broken seed dir', async () => {
    const parent = join(tmpdir(), `mihomo-seed2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const resources = join(parent, 'resources-geodata')
    const homeDir = join(parent, 'geodata')
    await mkdir(resources, { recursive: true })
    await writeFile(join(resources, 'geosite.dat'), 'older-bundle')

    const store = new MihomoKernelConfigStore({
      mixedPort: 29200,
      controllerPort: 29201,
      workspaceDir: parent,
      kernelHomeDir: homeDir,
      seedResourcesDir: resources
    })
    // First materialize seeds the bundled copy.
    const first = await store.materialize({ command: '/bin/mihomo', args: [] }, secret)
    await store.cleanup(first)
    // The kept copy is now NEWER than the (unmodified) bundle: a later start
    // must not overwrite it (e.g. with an older installer's database).
    const kept = join(homeDir, 'geosite.dat')
    const future = new Date(Date.now() + 60_000)
    const { utimes } = await import('node:fs/promises')
    await utimes(kept, future, future)

    const second = await store.materialize({ command: '/bin/mihomo', args: [] }, secret)
    await store.cleanup(second)
    await expect(readFile(kept, 'utf8')).resolves.toBe('older-bundle')

    // A missing seed dir is fail-open: materialize still succeeds.
    const broken = new MihomoKernelConfigStore({
      mixedPort: 29300,
      controllerPort: 29301,
      workspaceDir: parent,
      kernelHomeDir: join(parent, 'geodata-2'),
      seedResourcesDir: join(parent, 'does-not-exist')
    })
    const third = await broken.materialize({ command: '/bin/mihomo', args: [] }, secret)
    expect(third.args).toContain('-d')
    await broken.cleanup(third)
  })
})
