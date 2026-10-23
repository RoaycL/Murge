import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateChannel } from '@shared/app-settings'
import type { AppSettingsService } from './service'

/**
 * Written to the install directory by every new install of this build, not by
 * its own updates (resources/nsis/uninstall-restore.nsh). The Tauri build
 * writes the same file into its install directory.
 */
export const INSTALLER_CHANNEL_RESET_FILE = 'update-channel-reset'
/** Per user, in app data: which stamp this user has already applied. */
export const INSTALLER_CHANNEL_RESET_SEEN_FILE = 'update-channel-reset-seen'

/**
 * A user who installs this build by hand has chosen it, even when the other
 * build left its own channel in the shared settings: without this, a manual
 * install over the experimental (Tauri) build downloads Tauri again and
 * reinstalls it at the next quit. Applied once per install and per user, so a
 * later choice in the About page sticks. Returns true when the stamp was new.
 */
export async function applyInstallerChannelReset(
  settings: AppSettingsService,
  appDataBase: string,
  installDir: string,
  channel: UpdateChannel
): Promise<boolean> {
  let stamp: string
  try {
    stamp = (await stat(join(installDir, INSTALLER_CHANNEL_RESET_FILE), { bigint: true })).mtimeNs.toString()
  } catch {
    return false
  }
  const seenPath = join(appDataBase, INSTALLER_CHANNEL_RESET_SEEN_FILE)
  try {
    if ((await readFile(seenPath, 'utf8')) === stamp) return false
  } catch (error) {
    // Unreadable is not unseen: never undo a later channel choice because of
    // a transient read failure; try again next launch.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[app-settings] unable to read the installer channel stamp record:', error)
      return false
    }
  }
  try {
    if ((await settings.get()).updateChannel !== channel) {
      await settings.set({ updateChannel: channel })
      if ((await settings.get()).updateChannel !== channel) throw new Error('the update channel did not persist')
    }
    await mkdir(appDataBase, { recursive: true })
    await writeFile(seenPath, stamp, 'utf8')
  } catch (error) {
    console.error('[app-settings] update channel reset not applied; retrying next launch:', error)
    return false
  }
  return true
}
