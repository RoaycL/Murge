import { describe, expect, it } from 'vitest'
import { UpdateService } from '../src/main/updates/service'
import type { UpdaterDriver, UpdaterDriverEvent } from '../src/main/updates/updater-driver'
import { DEFAULT_UPDATE_STATE, coerceUpdateState } from '../src/shared/updates'
import type { UpdateState } from '../src/shared/updates'

/** A controllable fake driver so the service state machine is tested with no Electron. */
class FakeUpdaterDriver implements UpdaterDriver {
  readonly currentVersion = '0.0.0-test'
  configureCalls = 0
  checkCalls = 0
  downloadCalls = 0
  quitAndInstallCalls = 0
  disposeCalls = 0
  private listeners = new Set<(event: UpdaterDriverEvent) => void>()

  constructor(public supported = true) {}

  configure(): void {
    this.configureCalls += 1
  }

  check(): void {
    this.checkCalls += 1
  }

  download(): void {
    this.downloadCalls += 1
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1
  }

  onEvent(listener: (event: UpdaterDriverEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposeCalls += 1
  }

  emit(event: UpdaterDriverEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

describe('UpdateService', () => {
  it('start() configures the driver and subscribes to its events', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    expect(driver.configureCalls).toBe(0)
    service.start()
    expect(driver.configureCalls).toBe(1)
    expect(service.getState().currentVersion).toBe('0.0.0-test')
  })

  it('start() is idempotent', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    service.start()
    expect(driver.configureCalls).toBe(1)
  })

  it('check() reports a clear error when the driver is unsupported and never calls the driver', async () => {
    const driver = new FakeUpdaterDriver(false)
    const service = new UpdateService(driver)
    service.start()
    const state = await service.check()
    expect(state.phase).toBe('error')
    expect(state.error).toContain('不支持自动更新')
    expect(state.canInstall).toBe(false)
    expect(driver.checkCalls).toBe(0)
  })

  it('check() with a supported driver transitions to checking', async () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    const state = await service.check()
    expect(state.phase).toBe('checking')
    expect(driver.checkCalls).toBe(1)
  })

  it('check() reduces a synchronous driver throw into error (never stuck in checking)', async () => {
    const driver = new FakeUpdaterDriver()
    driver.check = () => {
      throw new Error('feed descriptor missing')
    }
    const service = new UpdateService(driver)
    service.start()
    const state = await service.check()
    expect(state.phase).toBe('error')
    expect(state.error).toBe('feed descriptor missing')
    // A later check must not be blocked by the previous stuck phase.
    driver.check = () => {}
    const next = await service.check()
    expect(next.phase).toBe('checking')
  })

  it('check() does not restart when a check or download is already in flight', async () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    await service.check()
    await service.check()
    expect(driver.checkCalls).toBe(1)

    // Once an update is fully downloaded, a newer check is also deferred so the
    // ready-to-install state is not clobbered by a transient "checking" phase.
    driver.emit({ kind: 'available', version: '1.0.1', releaseNotes: null })
    driver.emit({ kind: 'downloaded' })
    await service.check()
    expect(driver.checkCalls).toBe(1)
  })

  it('reduces an available event into the state snapshot', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    driver.emit({ kind: 'checking' })
    driver.emit({ kind: 'available', version: '1.2.3', releaseNotes: 'notes' })
    const state = service.getState()
    expect(state.phase).toBe('available')
    expect(state.availableVersion).toBe('1.2.3')
    expect(state.canInstall).toBe(false)
  })

  it('reduces download-progress events into the state snapshot', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    driver.emit({ kind: 'available', version: '1.0.1', releaseNotes: null })
    driver.emit({ kind: 'download-progress', percent: 42, bytesPerSecond: 2048, transferred: 1024, total: 4096 })
    const state = service.getState()
    expect(state.phase).toBe('downloading')
    expect(state.progress).toEqual({ percent: 42, bytesPerSecond: 2048, transferred: 1024, total: 4096 })
  })

  it('download() only starts from the available phase', async () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()

    // From idle nothing downloads yet.
    await service.download()
    expect(driver.downloadCalls).toBe(0)

    driver.emit({ kind: 'available', version: '1.0.1', releaseNotes: null })
    await service.download()
    expect(driver.downloadCalls).toBe(1)
    expect(service.getState().phase).toBe('downloading')
  })

  it('download() is a no-op when already downloaded', async () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    driver.emit({ kind: 'available', version: '1.0.1', releaseNotes: null })
    driver.emit({ kind: 'downloaded' })
    await service.download()
    expect(driver.downloadCalls).toBe(0)
  })

  it('marking downloaded enables install and clears progress', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    driver.emit({ kind: 'available', version: '1.0.1', releaseNotes: null })
    driver.emit({ kind: 'download-progress', percent: 100, bytesPerSecond: 1, transferred: 100, total: 100 })
    driver.emit({ kind: 'downloaded' })
    const state = service.getState()
    expect(state.phase).toBe('downloaded')
    expect(state.canInstall).toBe(true)
    expect(state.progress).toBeNull()
  })

  it('install() calls quitAndInstall only when supported and canInstall', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    service.install()
    expect(driver.quitAndInstallCalls).toBe(0)

    driver.emit({ kind: 'available', version: '1.0.1', releaseNotes: null })
    driver.emit({ kind: 'downloaded' })
    service.install()
    expect(driver.quitAndInstallCalls).toBe(1)
  })

  it('install() never calls quitAndInstall for an unsupported build', () => {
    const driver = new FakeUpdaterDriver(false)
    const service = new UpdateService(driver)
    service.start()
    driver.emit({ kind: 'available', version: '1.0.1', releaseNotes: null })
    driver.emit({ kind: 'downloaded' })
    service.install()
    expect(driver.quitAndInstallCalls).toBe(0)
  })

  it('reduces an error event into the state snapshot', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    driver.emit({ kind: 'checking' })
    driver.emit({ kind: 'error', message: 'network down' })
    const state = service.getState()
    expect(state.phase).toBe('error')
    expect(state.error).toBe('network down')
    expect(state.canInstall).toBe(false)
  })

  it('notifies onState subscribers and unsubscribes', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    const seen: UpdateState[] = []
    const unsubscribe = service.onState((state) => seen.push(state))
    driver.emit({ kind: 'available', version: '1.0.1', releaseNotes: null })
    expect(seen).toHaveLength(1)
    expect(seen[0].availableVersion).toBe('1.0.1')

    unsubscribe()
    driver.emit({ kind: 'downloaded' })
    expect(seen).toHaveLength(1)
  })

  it('dispose() unsubscribes the driver and clears listeners', () => {
    const driver = new FakeUpdaterDriver()
    const service = new UpdateService(driver)
    service.start()
    service.dispose()
    expect(driver.disposeCalls).toBe(1)
  })
})

describe('coerceUpdateState', () => {
  it('returns the default for non-object input', () => {
    expect(coerceUpdateState(null)).toEqual(DEFAULT_UPDATE_STATE)
    expect(coerceUpdateState('idle')).toEqual(DEFAULT_UPDATE_STATE)
    expect(coerceUpdateState([1, 2])).toEqual(DEFAULT_UPDATE_STATE)
  })

  it('returns the default for an empty object', () => {
    expect(coerceUpdateState({})).toEqual(DEFAULT_UPDATE_STATE)
  })

  it('coerces a complete valid payload', () => {
    const payload = {
      phase: 'downloaded',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      progress: { percent: 100, bytesPerSecond: 10, transferred: 10, total: 10 },
      error: null,
      canInstall: true
    }
    expect(coerceUpdateState(payload)).toEqual(payload)
  })

  it('falls back each malformed field independently', () => {
    const result = coerceUpdateState({ phase: 'bogus', currentVersion: 7, availableVersion: '1.1.0', progress: { percent: 'x' }, error: 3, canInstall: 'yes' })
    expect(result.phase).toBe(DEFAULT_UPDATE_STATE.phase)
    expect(result.currentVersion).toBe(DEFAULT_UPDATE_STATE.currentVersion)
    expect(result.availableVersion).toBe('1.1.0')
    expect(result.progress).toEqual({ percent: 0, bytesPerSecond: 0, transferred: 0, total: null })
    expect(result.error).toBe(DEFAULT_UPDATE_STATE.error)
    expect(result.canInstall).toBe(DEFAULT_UPDATE_STATE.canInstall)
  })
})
