import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  getLoginItemSettings: vi.fn(),
  setLoginItemSettings: vi.fn()
}))

vi.mock('electron', () => ({
  app: electron
}))

import { ElectronStartupAdapter } from '../src/main/startup/electron-adapter'
import { brand } from '../src/shared/brand'

describe('ElectronStartupAdapter', () => {
  beforeEach(() => {
    electron.getLoginItemSettings.mockReset()
    electron.setLoginItemSettings.mockReset()
  })

  it('detects a Run entry regardless of its registered arguments', async () => {
    electron.getLoginItemSettings.mockReturnValue({
      openAtLogin: false,
      executableWillLaunchAtLogin: true,
      launchItems: []
    })
    const adapter = new ElectronStartupAdapter(() => false, { supported: true })
    expect(await adapter.readRegistered()).toBe(true)
    expect(electron.getLoginItemSettings).toHaveBeenCalledWith({ path: process.execPath })
  })

  it('removes both historical argument shapes when disabling the fallback', async () => {
    electron.getLoginItemSettings.mockReturnValue({ launchItems: [] })
    const adapter = new ElectronStartupAdapter(() => true, { supported: true })
    await adapter.write(false)
    expect(electron.setLoginItemSettings).toHaveBeenNthCalledWith(1, {
      openAtLogin: false,
      path: process.execPath,
      args: [],
      name: brand.appId
    })
    expect(electron.setLoginItemSettings).toHaveBeenNthCalledWith(2, {
      openAtLogin: false,
      path: process.execPath,
      args: ['--hidden'],
      name: brand.appId
    })
  })

  it('removes an older Run entry even when it used a different value name', async () => {
    electron.getLoginItemSettings.mockReturnValue({
      launchItems: [{
        name: 'electron.app.client',
        path: process.execPath,
        args: ['--hidden'],
        scope: 'user',
        enabled: true
      }]
    })
    const adapter = new ElectronStartupAdapter(() => false, { supported: true })
    await adapter.write(false)
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: process.execPath,
      args: ['--hidden'],
      name: 'electron.app.client'
    })
  })

  it('uses the stable appId as the registry value name when enabling', async () => {
    const adapter = new ElectronStartupAdapter(() => false, { supported: true })
    await adapter.write(true)
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: process.execPath,
      args: ['--hidden'],
      name: brand.appId
    })
  })

  it('keeps login launches hidden even when an old preference requests a popup', async () => {
    const adapter = new ElectronStartupAdapter(() => false, { supported: true })
    await adapter.write(true)
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({
      openAtLogin: true,
      args: ['--hidden']
    }))
  })
})
