import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// P1-3: the uninstaller's `customUnInstall` hook must NOT silently swallow a
// failed system-proxy restore. Before electron-builder deletes the installed
// files, the app is asked to restore the owned HKCU proxy; if that exits non-zero
// the uninstaller must abort (keeping the app binary + restore tool) rather than
// leave the OS pointing at a now-removed port.
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

  it('aborts the uninstall on a non-zero restore exit, keeping the app + tool', () => {
    expect(source).toContain('Abort')
    // The abort path is only reached on failure (not on exit 0 / safe conflict).
    expect(source).toMatch(/StrCmp \$R0 0[^\n]*SystemProxyUninstallRestoreDone[^\n]*SystemProxyUninstallRestoreFailed/)
    expect(source).toContain('SystemProxyUninstallRestoreFailed:')
    expect(source).toContain('SetErrorLevel 1')
    expect(source).toContain('保留程序与还原工具')
  })

  it('still lets a clean restore (exit 0) and a safe conflict continue', () => {
    // Exit 0 flows straight to the Done label; no Abort is reached.
    const doneIndex = source.indexOf('SystemProxyUninstallRestoreDone:')
    const failedIndex = source.indexOf('SystemProxyUninstallRestoreFailed:')
    expect(doneIndex).toBeGreaterThan(-1)
    expect(failedIndex).toBeGreaterThan(-1)
    // On success the control flow lands at Done and the uninstall continues.
    expect(source.slice(0, doneIndex)).toContain('StrCmp $R0 0')
  })

  it('launches Electron restore only when the durable ownership backup exists', () => {
    expect(source).toContain('IfFileExists "$APPDATA\\system-proxy\\owned-backup.json"')
    expect(source).toContain(
      'IfFileExists "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" 0 SystemProxyUninstallRestoreFailed'
    )
    expect(source).not.toContain('MURGE_CI_SKIP_ELECTRON_RESTORE')
    expect(source).not.toContain('GITHUB_ACTIONS')
  })

  it('installs and removes the privileged TUN service fail-closed', () => {
    expect(source).toContain('--install')
    expect(source).toContain('--uninstall')
    expect(source).toContain('TunServiceInstallFailed:')
    expect(source).toContain('TunServiceUninstallFailed:')
    expect(source).toMatch(/ExecWait[^\n]*--install[^\n]*\$R0/)
    expect(source).toMatch(/ExecWait[^\n]*--uninstall[^\n]*\$R0/)
  })
})
