import { app } from 'electron'
import { brand } from '@shared/brand'
import type { StartupAdapter } from './service'

/**
 * Windows login-item adapter. The registration args depend on the persisted
 * Every login launch carries `--hidden`: starting with Windows is a tray-only
 * action and a manual launch remains the explicit way to open the dashboard.
 * Read and write MUST agree on the same args — Electron's
 * `getLoginItemSettings({ args })` matches the exact argument shape.
 */
export class ElectronStartupAdapter implements StartupAdapter {
  readonly supported: boolean

  /** Legacy provider retained for constructor compatibility. */
  constructor(
    _getSilentLaunch: () => boolean = () => false,
    options?: { supported?: boolean }
  ) {
    this.supported = options?.supported ?? process.platform === 'win32'
  }

  async read(): Promise<boolean> {
    if (!this.supported) return false
    return app
      .getLoginItemSettings({ path: process.execPath, args: this.loginArgs() })
      .openAtLogin
  }

  /** Existence check regardless of registered arguments (used by migration). */
  async readRegistered(): Promise<boolean> {
    if (!this.supported) return false
    return app.getLoginItemSettings({ path: process.execPath }).executableWillLaunchAtLogin
  }

  async write(enabled: boolean): Promise<void> {
    if (!this.supported) return
    if (!enabled) {
      // Electron matches Windows login entries by their registered argument
      // shape and value name. Include entries Electron reports for this exact
      // executable so registrations created before the stable appId name was
      // introduced are retired too.
      const registered = app.getLoginItemSettings({ path: process.execPath })
      const candidates = [
        { name: brand.appId, path: process.execPath, args: [] as string[] },
        { name: brand.appId, path: process.execPath, args: ['--hidden'] },
        ...(registered.launchItems ?? [])
          .filter((item) => item.scope === 'user' && item.path.toLowerCase() === process.execPath.toLowerCase())
          .map((item) => ({ name: item.name, path: item.path, args: item.args }))
      ]
      const seen = new Set<string>()
      for (const candidate of candidates) {
        const key = `${candidate.name}\0${candidate.path.toLowerCase()}\0${candidate.args.join('\0')}`
        if (seen.has(key)) continue
        seen.add(key)
        app.setLoginItemSettings({
          openAtLogin: false,
          path: candidate.path,
          args: candidate.args,
          name: candidate.name
        })
      }
      return
    }
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: this.loginArgs(),
      name: brand.appId
    })
  }

  async rewriteIfEnabled(): Promise<void> {
    if (!this.supported) return
    // Query without argument matching so a registration created with the old
    // silent-launch value is still found, then overwrite it with current args.
    const registered = app.getLoginItemSettings({ path: process.execPath }).executableWillLaunchAtLogin
    if (registered) await this.write(true)
  }

  private loginArgs(): string[] {
    return ['--hidden']
  }
}
