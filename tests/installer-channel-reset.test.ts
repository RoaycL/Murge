import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettingsService } from '../src/main/app-settings/service'
import {
  applyInstallerChannelReset,
  INSTALLER_CHANNEL_RESET_FILE,
  INSTALLER_CHANNEL_RESET_SEEN_FILE
} from '../src/main/app-settings/installer-channel-reset'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'channel-reset-'))
  dirs.push(dir)
  return dir
}

describe('applyInstallerChannelReset', () => {
  it('moves a channel left by the Tauri build back to stable once per install and user', async () => {
    const installDir = await tempDir()
    const appData = await tempDir()
    const settings = new AppSettingsService(appData)
    await settings.set({ updateChannel: 'experimental' })

    // No stamp: nothing changes.
    expect(await applyInstallerChannelReset(settings, appData, installDir, 'stable')).toBe(false)
    expect((await settings.get()).updateChannel).toBe('experimental')

    await writeFile(join(installDir, INSTALLER_CHANNEL_RESET_FILE), 'stable')
    expect(await applyInstallerChannelReset(settings, appData, installDir, 'stable')).toBe(true)
    expect((await settings.get()).updateChannel).toBe('stable')

    // A later choice in the About page sticks.
    await settings.set({ updateChannel: 'experimental' })
    expect(await applyInstallerChannelReset(settings, appData, installDir, 'stable')).toBe(false)
    expect((await settings.get()).updateChannel).toBe('experimental')

    // Another user of the machine gets the reset too.
    const otherUser = join(await tempDir(), 'fresh')
    const otherSettings = new AppSettingsService(otherUser)
    expect(await applyInstallerChannelReset(otherSettings, otherUser, installDir, 'stable')).toBe(true)
    expect(await readFile(join(otherUser, INSTALLER_CHANNEL_RESET_SEEN_FILE), 'utf8')).toMatch(/^\d+$/)

    // A later manual install rewrites the stamp and resets again.
    await utimes(join(installDir, INSTALLER_CHANNEL_RESET_FILE), new Date(), new Date(Date.now() + 60_000))
    expect(await applyInstallerChannelReset(settings, appData, installDir, 'stable')).toBe(true)
    expect((await settings.get()).updateChannel).toBe('stable')
  })

  it('treats an unreadable record as seen rather than undoing a later choice', async () => {
    const installDir = await tempDir()
    const appData = await tempDir()
    const settings = new AppSettingsService(appData)
    await settings.set({ updateChannel: 'experimental' })
    await writeFile(join(installDir, INSTALLER_CHANNEL_RESET_FILE), 'stable')
    // A directory where the record should be makes the read fail.
    await mkdir(join(appData, INSTALLER_CHANNEL_RESET_SEEN_FILE))
    expect(await applyInstallerChannelReset(settings, appData, installDir, 'stable')).toBe(false)
    expect((await settings.get()).updateChannel).toBe('experimental')
  })

  it('waits while the settings file is unreadable', async () => {
    const installDir = await tempDir()
    const appData = await tempDir()
    await writeFile(join(installDir, INSTALLER_CHANNEL_RESET_FILE), 'stable')
    // A directory where the file should be makes every read fail.
    await mkdir(join(appData, 'app-settings.json'))
    const settings = new AppSettingsService(appData)
    expect(await applyInstallerChannelReset(settings, appData, installDir, 'stable')).toBe(false)
    await expect(readFile(join(appData, INSTALLER_CHANNEL_RESET_SEEN_FILE), 'utf8')).rejects.toThrow()
  })

  it('uses the stamp name the installer writes', async () => {
    const source = await readFile('resources/nsis/uninstall-restore.nsh', 'utf8')
    expect(source).toContain(`!define MURGE_CHANNEL_RESET_FILE "${INSTALLER_CHANNEL_RESET_FILE}"`)
    const install = source.slice(source.indexOf('!macro customInstall'), source.indexOf('!macroend', source.indexOf('!macro customInstall')))
    // Written by a new install only; this build's own updates keep the old stamp.
    expect(install).toMatch(/\$\{else\}\s+ClearErrors\s+FileOpen \$R0 "\$INSTDIR\\\$\{MURGE_CHANNEL_RESET_FILE\}" w/)
    // A self-update puts back the stamp customInit kept, time included, so
    // users who have not launched since the last new install still reset.
    const init = source.slice(source.indexOf('!macro customInit'), source.indexOf('!macroend', source.indexOf('!macro customInit')))
    expect(init).toContain('CopyFiles /SILENT "$INSTDIR\\${MURGE_CHANNEL_RESET_FILE}" "$PLUGINSDIR\\${MURGE_CHANNEL_RESET_FILE}"')
    expect(install).toMatch(/\$\{if\} \$\{isUpdated\}[\s\S]*CopyFiles \/SILENT "\$PLUGINSDIR\\\$\{MURGE_CHANNEL_RESET_FILE\}" "\$INSTDIR\\\$\{MURGE_CHANNEL_RESET_FILE\}"[\s\S]*\$\{else\}/)
  })
})
