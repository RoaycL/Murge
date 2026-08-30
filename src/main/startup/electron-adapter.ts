import { app } from 'electron'
import type { StartupAdapter } from './service'

export class ElectronStartupAdapter implements StartupAdapter {
  readonly supported = process.platform === 'win32'
  async read(): Promise<boolean> {
    if (!this.supported) return false
    return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin
  }
  async write(enabled: boolean): Promise<void> {
    if (!this.supported) return
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] })
  }
}

