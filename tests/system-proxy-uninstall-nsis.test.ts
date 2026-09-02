import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// P1-3 (revised): the uninstaller's `customUnInstall` hook must ATTEMPT to restore
// the owned system proxy before electron-builder deletes the installed files, but
// it must NEVER trap the user on a broken install. The restore is performed by
// launching the *installed* app binary, so a release that cannot boot (e.g. a
// crash bug) would make uninstall — and therefore every future upgrade —
// impossible if the hook hard-aborted on a non-zero restore exit. The hook now
// warns and continues, so removal is never blocked; the healthy case still
// restores (exit 0 -> continue) as before.
//
// We can't compile/run the NSIS installer on the Linux verify job, but the hook is
// generated from this checked-in macro, so a content test is a faithful regression
// guard for the branch/abort behavior. (The real uninstaller is built and
// exercised on windows-latest in the package-win job.)
describe('uninstall-restore.nsh customUnInstall hook', () => {
  let source: string
  beforeAll(async () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources/nsis/uninstall-restore.nsh')
    source = await readFile(file, 'utf8')
  })

  it('invokes the app restore hook and captures its exit code', () => {
    expect(source).toContain('--restore-system-proxy')
    expect(source).toContain('ExecWait')
    expect(source).toMatch(/ExecWait[^\n]*\$R0/)
  })

  it('branches on the restore exit code (must not be ignored)', () => {
    expect(source).toContain('StrCmp $R0 0')
  })

  it('warns and CONTINUES on a non-zero restore exit so uninstall is never blocked', () => {
    // A failed proxy restore must NOT Abort — that would trap the user on a release
    // that cannot boot. It flows to the Warn label and carries on.
    expect(source).toContain('SystemProxyUninstallRestoreWarn:')
    expect(source).toMatch(
      /StrCmp \$R0 0[^\n]*SystemProxyUninstallRestoreDone[^\n]*SystemProxyUninstallRestoreWarn/
    )
    // The warn path still surfaces an explanatory message (not silently swallowed).
    const warnIndex = source.indexOf('SystemProxyUninstallRestoreWarn:')
    const warnRegion = source.slice(warnIndex)
    expect(warnRegion).toMatch(/MessageBox/)
    // The proxy-restore path itself carries no hard Abort / error level anymore.
    // Anchor on the boundary of the uninstall macro (the TUN block follows the
    // Done label, so the slice is exactly the proxy-restore portion) up to the
    // Done label.
    const macroIndex = source.indexOf('!macro customUnInstall')
    const doneIndex = source.indexOf('SystemProxyUninstallRestoreDone:')
    const restorePath = source.slice(macroIndex, doneIndex)
    expect(restorePath).not.toContain('Abort')
    expect(restorePath).not.toContain('SetErrorLevel 1')
  })

  it('still lets a clean restore (exit 0) continue', () => {
    // Exit 0 flows straight to the Done label; no Abort is reached in that branch.
    expect(source).toContain('StrCmp $R0 0 SystemProxyUninstallRestoreDone')
    expect(source).toContain('SystemProxyUninstallRestoreDone:')
  })

  it('launches Electron restore only when the durable ownership backup exists', () => {
    expect(source).toContain('IfFileExists "$APPDATA\\system-proxy\\owned-backup.json"')
    expect(source).toContain(
      'IfFileExists "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" 0 SystemProxyUninstallRestoreWarn'
    )
    expect(source).not.toContain('MURGE_CI_SKIP_ELECTRON_RESTORE')
    expect(source).not.toContain('GITHUB_ACTIONS')
  })

  it('treats the privileged TUN service as optional (install/remove warn and continue)', () => {
    expect(source).toContain('--install')
    expect(source).toContain('--uninstall')
    expect(source).toMatch(/ExecWait[^\n]*--install[^\n]*\$R0/)
    expect(source).toMatch(/ExecWait[^\n]*--uninstall[^\n]*\$R0/)
    // The TUN service only backs TUN-adapter mode; the core system-proxy mode
    // launches the mihomo kernel directly and never needs it. So a TUN install or
    // removal failure must NOT abort — it must warn and continue, matching the
    // proxy-restore policy. No hard Abort / error level may remain anywhere.
    expect(source).toContain('TunServiceInstallWarn:')
    expect(source).toContain('TunServiceUninstallWarn:')
    expect(source).toMatch(/StrCmp \$R0 0[^\n]*TunServiceInstallDone[^\n]*TunServiceInstallWarn/)
    expect(source).toMatch(/StrCmp \$R0 0[^\n]*TunServiceUninstallDone[^\n]*TunServiceUninstallWarn/)
    const installWarn = source.indexOf('TunServiceInstallWarn:')
    expect(source.slice(installWarn)).toMatch(/MessageBox/)
    const uninstallWarn = source.indexOf('TunServiceUninstallWarn:')
    expect(source.slice(uninstallWarn)).toMatch(/MessageBox/)
    expect(source).not.toContain('Abort')
    expect(source).not.toContain('SetErrorLevel 1')
  })
})
