import { t } from '@shared/i18n'
import { toProtocolError } from '@shared/protocol-errors'
import { useProfilesStore } from '../stores/profiles'
import { useToast } from './use-toast'

/**
 * 打开文件: a profile opened in the user's own editor. The document as it was
 * when opened (or last applied) is remembered; when the window regains focus
 * a changed file is validated and applied exactly like an in-app save, so
 * the running profile reloads. Lives outside any view: leaving the 配置 page
 * keeps the watch.
 */
const snapshots = new Map<string, string>()
let listening = false
let syncing = false

async function syncExternalEdits(): Promise<void> {
  if (syncing || snapshots.size === 0) return
  syncing = true
  const store = useProfilesStore()
  const toast = useToast()
  try {
    for (const [id, snapshot] of [...snapshots]) {
      let profile
      try {
        profile = await window.desktop.profiles.get(id)
      } catch {
        snapshots.delete(id) // deleted meanwhile
        continue
      }
      const document = profile.document
      if (document === snapshot) continue
      // Remember this version either way: an invalid save is reported once,
      // the next save is checked again.
      snapshots.set(id, document)
      const name = profile.meta.name
      const result = await store.validate(document)
      if (!result.ok) {
        toast.error(t('profiles.externalInvalid', [name]), result.issues.map((issue) => issue.message).join(t('common.semicolon')))
        continue
      }
      try {
        await store.replaceDocument(id, document)
        toast.success(t('profiles.externalApplied', [name]), profile.meta.active ? t('profiles.reloaded') : undefined)
      } catch (error) {
        toast.error(t('profiles.externalFailed', [name]), toProtocolError(error).message)
      }
    }
  } finally {
    syncing = false
  }
}

/** Open the profile's YAML in the chosen editor and watch it for saves. */
export async function openProfileFile(id: string): Promise<void> {
  const toast = useToast()
  try {
    const profile = await window.desktop.profiles.get(id)
    await window.desktop.profiles.openFile(id)
    snapshots.set(id, profile.document)
    if (!listening) {
      listening = true
      window.addEventListener('focus', () => { void syncExternalEdits() })
    }
    toast.info(t('profiles.openedExternal'), t('profiles.openedExternalHint'))
  } catch (error) {
    toast.error(t('profiles.openFileFailed'), toProtocolError(error).message)
  }
}

/** Test seam: forget every watched profile. */
export function resetExternalProfileEdits(): void {
  snapshots.clear()
  syncing = false
}

export { syncExternalEdits }
