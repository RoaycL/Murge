import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// Switching from the experimental (Tauri) build back to stable runs this
// build's installer over the Tauri install. makensis only runs on the Windows
// package job, so the macro's contract is guarded here by content.
describe('Electron installer takes over a Tauri installation', () => {
  it('runs the Tauri uninstaller in update mode before installing', async () => {
    const source = await readFile('resources/nsis/uninstall-restore.nsh', 'utf8')
    const init = source.slice(source.indexOf('!macro customInit'), source.indexOf('!macroend', source.indexOf('!macro customInit')))
    // The Tauri bundler's per-machine key is Uninstall\<productName>.
    expect(source).toContain('!define MURGE_TAURI_UNINSTALL_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}"')
    expect(init).toContain('ReadRegStr $R0 HKLM "${MURGE_TAURI_UNINSTALL_KEY}" "InstallLocation"')
    // /UPDATE keeps the service, its state, the startup task and app data.
    expect(init).toMatch(/ExecWait '"\$PLUGINSDIR\\tauri-uninstaller\.exe" \/S \/UPDATE _\?=\$R0' \$R3/)
    // A failed takeover must stop the install rather than leave two installs.
    expect(init).toMatch(/TauriTakeoverFailed:[\s\S]*Quit\s+TauriTakeoverDone:/)
  })
})
