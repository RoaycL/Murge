import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('update notification navigation contract', () => {
  it('publishes only the final feed failure after proxy fallback is exhausted', async () => {
    const [driver, about] = await Promise.all([
      read('src/main/updates/electron-updater-driver.ts'),
      read('src/renderer/src/views/AboutView.vue')
    ])
    expect(driver).toContain('private checkingWithFallback = false')
    expect(driver).toContain('autoUpdater.disableWebInstaller = true')
    expect(driver).toMatch(/autoUpdater\.on\('error',[\s\S]*if \(this\.checkingWithFallback\) return/)
    expect(driver).toMatch(/this\.checkingWithFallback = true[\s\S]*finally \{[\s\S]*this\.checkingWithFallback = false/)
    expect(driver).toMatch(/net\.fetch\(`\$\{base\}\/latest\.yml`/)
    expect(driver).toMatch(/releases\/latest\/download/)
    expect(driver).toMatch(/autoUpdater\.setFeedURL\(\{ provider: 'generic', url: selectedBase \}\)[\s\S]*autoUpdater\.checkForUpdates\(\)/)
    expect(driver.match(/autoUpdater\.checkForUpdates\(\)/g)).toHaveLength(1)
    expect(driver).not.toContain('withTimeout(autoUpdater.checkForUpdates')
    expect(driver).toContain('private checkInFlight = false')
    expect(about).not.toMatch(/error \|\| updates\.state\.error/)
  })

  it('routes native notification clicks to the existing About page', async () => {
    const [driver, main, whenReady, shared, preload, app] = await Promise.all([
      read('src/main/updates/electron-updater-driver.ts'),
      // Phase 1: the showMainWindowAt implementation lives in the window
      // adapter; the driver construction in when-ready.
      read('src/main/electron/window-adapter.ts'),
      read('src/main/electron/when-ready.ts'),
      read('src/shared/ipc.ts'),
      read('src/preload/index.ts'),
      read('src/renderer/src/App.vue')
    ])

    expect(driver).toMatch(/notification\.once\('click',[\s\S]*this\.onNotificationClick\(\)/)
    expect(main).toContain("showMainWindowAt(route: '/about')")
    expect(main).toMatch(/showMainWindowAt\(route: '\/about'\)[\s\S]*window\.show\(\)[\s\S]*window\.focus\(\)[\s\S]*IPC\.appNavigateEvent/)
    expect(whenReady).toContain("new ElectronUpdaterDriver(() => windowAdapter.showMainWindowAt('/about'))")
    expect(shared).toContain("appNavigateEvent: 'app:navigate-event'")
    expect(preload).toContain('onNavigate: (listener) => listen(IPC.appNavigateEvent, listener)')
    expect(app).toMatch(/onNavigate\(\(path\) => \{ void router\.push\(path\) \}\)/)
  })
})
