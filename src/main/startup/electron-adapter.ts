import { app } from 'electron'
import type { StartupAdapter } from './service'

/**
 * Windows login-item adapter. The registration args depend on the persisted
 * `silentLaunch` preference: silent launches carry `--hidden` (the flag the
 * window-creation path reads to skip showing the main window), while a loud
 * login launch registers without args. Read and write MUST agree on the same
 * args — Electron's `getLoginItemSettings({ args })` matches the login item
 * registered with exactly those arguments, so a mismatch would make the
 * toggle read as off right after enabling it.
 */
export class ElectronStartupAdapter implements StartupAdapter {
  readonly supported = process.platform === 'win32'

  /** Sync provider for the persisted silent-launch preference. */
  constructor(private readonly getSilentLaunch: () => boolean = () => false) {}

  async read(): Promise<boolean> {
    if (!this.supported) return false
    return app
      .getLoginItemSettings({ path: process.execPath, args: this.loginArgs() })
      .openAtLogin
  }

  async write(enabled: boolean): Promise<void> {
    if (!this.supported) return
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: this.loginArgs()
    })
  }

  async rewriteIfEnabled(): Promise<void> {
    if (!this.supported) return
    // Query without argument matching so a registration created with the old
    // silent-launch value is still found, then overwrite it with current args.
    const registered = app.getLoginItemSettings({ path: process.execPath }).openAtLogin
    if (registered) await this.write(true)
  }

  private loginArgs(): string[] {
    return this.getSilentLaunch() ? ['--hidden'] : []
  }
}
