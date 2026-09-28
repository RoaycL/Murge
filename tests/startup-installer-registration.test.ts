import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('installer-owned startup registration', () => {
  it('ships the registration script and uses the elevated install hook', async () => {
    const config = await readFile(path.join(root, 'electron-builder.config.mjs'), 'utf8')
    const nsis = await readFile(path.join(root, 'resources/nsis/uninstall-restore.nsh'), 'utf8')
    expect(config).toContain("{ from: 'resources/startup', to: 'startup', filter: ['register-task.ps1'] }")
    expect(config).toContain('perMachine: true')
    expect(config).toContain('allowElevation: true')
    expect(nsis).toContain('!macro customInit')
    expect(nsis).toContain('!macro customInstall')
    expect(nsis.indexOf('ReadRegStr $R8 HKCU')).toBeLessThan(nsis.indexOf('!macro customInstall'))
    expect(nsis).toContain('register-task.ps1" -TaskName "${APP_ID}"')
    expect(nsis).toContain('Get-ScheduledTask -TaskName ${APP_ID}')
    expect(nsis).toContain('StrCmp $R0 0 StartupTaskInstallDone StartupTaskInstallFailed')
    expect(nsis.indexOf('StartupTaskInstallDone:')).toBeLessThan(nsis.indexOf('DeleteRegValue HKCU'))
    expect(nsis).toContain('WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${APP_ID}"')
  })

  it('retains startup intent across upgrades and removes it on real uninstall', async () => {
    const nsis = await readFile(path.join(root, 'resources/nsis/uninstall-restore.nsh'), 'utf8')
    const uninstall = nsis.slice(nsis.indexOf('!macro customUnInstall'))
    const taskRemoval = uninstall.indexOf('schtasks /delete /tn "${APP_ID}" /f')
    expect(taskRemoval).toBeGreaterThan(uninstall.indexOf('${ifNot} ${isUpdated}'))
    expect(taskRemoval).toBeLessThan(uninstall.lastIndexOf('${endif}'))
    expect(uninstall).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${APP_ID}"')
  })

  it('binds both the task and trigger to the interactive user without elevating the GUI', async () => {
    const script = await readFile(path.join(root, 'resources/startup/register-task.ps1'), 'utf8')
    expect(script).toContain('$trigger.UserId = $sid')
    expect(script).toContain('$definition.Principal.UserId = $sid')
    expect(script).toContain('$definition.Principal.LogonType = 3')
    expect(script).toContain('$definition.Principal.RunLevel = 0')
    expect(script).toContain('$definition.Settings.Priority = 3')
    expect(script).toContain("$definition.Settings.ExecutionTimeLimit = 'PT0S'")
    expect(script).toContain('D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$sid)')
    expect(script).toContain('$PreviouslyEnabled -eq \'1\'')
    expect(script).toContain('$folder.RegisterTaskDefinition')
    expect(script).toContain('while ($null -ne $taskError.InnerException)')
    expect(script).toContain('$taskError.HResult -notin @(-2147024894, -2147216625)')
  })
})
