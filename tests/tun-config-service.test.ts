import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TunConfigService, TUN_CONFIG_FILE } from '../src/main/tun/tun-config-service'
import { EMPTY_TUN_CONFIG, LEGACY_TUN_MTU_DEFAULT } from '../src/shared/tun-config'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tun-config-'))
}

describe('TunConfigService', () => {
  it('returns safe defaults before anything is persisted', async () => {
    const dir = await makeDir()
    const service = new TunConfigService(dir)
    expect((await service.get()).config).toEqual(EMPTY_TUN_CONFIG)
  })

  it('persists atomically and reloads from disk', async () => {
    const dir = await makeDir()
    const service = new TunConfigService(dir)
    await service.set({ ...EMPTY_TUN_CONFIG, device: 'TUN-0', mtu: 1500, strictRoute: true })

    const reloaded = new TunConfigService(dir)
    const snapshot = await reloaded.get()
    expect(snapshot.config.device).toBe('TUN-0')
    expect(snapshot.config.mtu).toBe(1500)
    expect(snapshot.config.strictRoute).toBe(true)

    const raw = await readFile(join(dir, TUN_CONFIG_FILE), 'utf8')
    expect(JSON.parse(raw).config.mtu).toBe(1500)
  })

  it('coerces a stale or hand-edited file instead of crashing', async () => {
    const dir = await makeDir()
    const service = new TunConfigService(dir)
    await service.set(EMPTY_TUN_CONFIG)
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(dir, TUN_CONFIG_FILE), '{not json', 'utf8'))
    const reloaded = new TunConfigService(dir)
    expect((await reloaded.get()).config).toEqual(EMPTY_TUN_CONFIG)
  })

  it('readConfig exposes the current model for the owned adapter', async () => {
    const dir = await makeDir()
    const service = new TunConfigService(dir)
    expect(await service.readConfig()).toEqual(EMPTY_TUN_CONFIG)
    await service.set({ ...EMPTY_TUN_CONFIG, stack: 'system', autoRoute: false })
    expect(await service.readConfig()).toMatchObject({ stack: 'system', autoRoute: false })
  })

  it('preview renders an enabled tun block without writing', async () => {
    const dir = await makeDir()
    const service = new TunConfigService(dir)
    const preview = service.preview({ ...EMPTY_TUN_CONFIG, mtu: 1500, routeAddress: ['192.168.0.0/16'] })
    expect(preview).toContain('tun:')
    expect(preview).toContain('enable: true')
    expect(preview).toContain('mtu: 1500')
    expect(preview).toContain('192.168.0.0/16')
    const reloaded = new TunConfigService(dir)
    expect((await reloaded.get()).config).toEqual(EMPTY_TUN_CONFIG)
  })

  it('migrates the legacy 9000 default to 1500 on load and persists it', async () => {
    const dir = await makeDir()
    // Simulate a 0.5.7 install that saved the TUN form with the stock default.
    await writeFile(
      join(dir, TUN_CONFIG_FILE),
      JSON.stringify({ config: { ...EMPTY_TUN_CONFIG, mtu: LEGACY_TUN_MTU_DEFAULT } }, null, 2),
      'utf8'
    )
    const service = new TunConfigService(dir)
    const config = (await service.get()).config
    expect(config.mtu).toBe(1500)
    // The migration writes back so the file no longer carries the stale default.
    const raw = await readFile(join(dir, TUN_CONFIG_FILE), 'utf8')
    expect(JSON.parse(raw).config.mtu).toBe(1500)
  })

  it('preserves a user-customized mtu across the default migration', async () => {
    const dir = await makeDir()
    await writeFile(
      join(dir, TUN_CONFIG_FILE),
      JSON.stringify({ config: { ...EMPTY_TUN_CONFIG, mtu: 1420 } }, null, 2),
      'utf8'
    )
    const service = new TunConfigService(dir)
    expect((await service.get()).config.mtu).toBe(1420)
    // No persistence on the untouched-customization path.
    const raw = await readFile(join(dir, TUN_CONFIG_FILE), 'utf8')
    expect(JSON.parse(raw).config.mtu).toBe(1420)
  })
})
