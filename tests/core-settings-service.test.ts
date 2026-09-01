import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreSettingsService, CORE_SETTINGS_FILE } from '../src/main/kernel/core-settings-service'
import { EMPTY_CORE_SETTINGS } from '@shared/core-settings'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'core-settings-'))
}

describe('CoreSettingsService', () => {
  it('returns safe defaults before anything is persisted', async () => {
    const dir = await makeDir()
    const service = new CoreSettingsService(dir)
    expect(await service.get()).toEqual(EMPTY_CORE_SETTINGS)
  })

  it('persists atomically and reloads from disk', async () => {
    const dir = await makeDir()
    const service = new CoreSettingsService(dir)
    const saved = await service.set({ ...EMPTY_CORE_SETTINGS, enabled: true, logLevel: 'error', ipv6: true })
    expect(saved.enabled).toBe(true)
    expect(saved.logLevel).toBe('error')
    expect(saved.ipv6).toBe(true)

    const reloaded = new CoreSettingsService(dir)
    const reloadedSettings = await reloaded.get()
    expect(reloadedSettings).toEqual(saved)

    const raw = await readFile(join(dir, CORE_SETTINGS_FILE), 'utf8')
    expect(JSON.parse(raw).enabled).toBe(true)
  })

  it('coerces a stale or hand-edited file instead of crashing', async () => {
    const dir = await makeDir()
    const service = new CoreSettingsService(dir)
    await service.set(EMPTY_CORE_SETTINGS)
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(join(dir, CORE_SETTINGS_FILE), '{not json', 'utf8')
    )
    const reloaded = new CoreSettingsService(dir)
    expect(await reloaded.get()).toEqual(EMPTY_CORE_SETTINGS)
  })

  it('renders a yaml preview of the mihomo core keys', async () => {
    const dir = await makeDir()
    const service = new CoreSettingsService(dir)
    const preview = service.preview({ ...EMPTY_CORE_SETTINGS, enabled: true, logLevel: 'warning', tcpConcurrent: true })
    expect(preview).toContain('log-level: warning')
    expect(preview).toContain('tcp-concurrent: true')
    expect(preview).toContain('ipv6: false')
  })
})
