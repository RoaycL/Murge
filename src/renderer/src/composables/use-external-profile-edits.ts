import { t } from '@shared/i18n'
import { toProtocolError } from '@shared/protocol-errors'
import { useProfilesStore } from '../stores/profiles'
import { useToast } from './use-toast'

/**
 * 打开文件: the editor works on a copy of the profile's YAML, never the stored
 * document. When the window regains focus, a changed copy is validated and
 * applied exactly like an in-app save (the running profile reloads); a
 * broken save is reported and the stored document stays as it was. Lives
 * outside any view: leaving the 配置 page keeps the watch.
 */
const snapshots = new Map<string, string>()
/**
 * The stored document each working copy is based on. When the profile
 * changes elsewhere (subscription update, in-app edit) after the copy was
 * opened, an external save would silently undo that change, so it is not
 * applied; reopening the file stages a fresh copy (the old one goes to backup/).
 */
const baselines = new Map<string, string>()
let listening = false
let syncing = false
let pending = false

async function syncExternalEdits(): Promise<void> {
  if (syncing) { pending = true; return }
  if (snapshots.size === 0) return
  syncing = true
  const store = useProfilesStore()
  const toast = useToast()
  try {
    for (const [id, snapshot] of [...snapshots]) {
      let document: string | null
      try {
        document = await window.desktop.profiles.readExternal(id)
      } catch {
        continue // unreadable right now (editor mid-save): try on the next focus
      }
      if (document === null || !store.profiles.some((meta) => meta.id === id)) {
        snapshots.delete(id) // copy or profile gone
        baselines.delete(id)
        continue
      }
      if (document === snapshot) continue
      // Remember this version either way: an invalid save is reported once,
      // the next save is checked again. The copy itself is never written,
      // so a newer editor save is never overwritten.
      snapshots.set(id, document)
      const name = store.profiles.find((meta) => meta.id === id)?.name ?? id
      const active = store.profiles.find((meta) => meta.id === id)?.active === true
      const result = await store.validate(document)
      if (!result.ok) {
        toast.error(t('profiles.externalInvalid', [name]), result.issues.map((issue) => issue.message).join(t('common.semicolon')))
        continue
      }
      const baseline = baselines.get(id)
      if (baseline !== undefined) {
        const current = (await window.desktop.profiles.get(id)).document
        if (current !== baseline) {
          toast.error(t('profiles.externalConflict', [name]), t('profiles.externalConflictDetail'))
          continue
        }
      }
      try {
        await store.replaceDocument(id, document)
        baselines.set(id, (await window.desktop.profiles.get(id)).document)
        toast.success(t('profiles.externalApplied', [name]), active ? t('profiles.reloaded') : undefined)
      } catch (error) {
        // A valid edit that could not be applied (e.g. the kernel failed to
        // reload) stays eligible: the next focus tries it again.
        snapshots.set(id, snapshot)
        toast.error(t('profiles.externalFailed', [name]), toProtocolError(error).message)
      }
    }
  } finally {
    syncing = false
  }
  // A focus that arrived mid-sync may carry a newer save.
  if (pending) { pending = false; await syncExternalEdits() }
}

/** Open a working copy of the profile's YAML in the chosen editor and watch it for saves. */
export async function openProfileFile(id: string): Promise<void> {
  const toast = useToast()
  try {
    const { keptUnapplied } = await window.desktop.profiles.openFile(id)
    const staged = await window.desktop.profiles.readExternal(id)
    if (staged !== null) {
      const stored = (await window.desktop.profiles.get(id)).document
      baselines.set(id, stored)
      // A kept copy holds edits not applied yet: the next focus checks them
      // again (the stored document is the baseline, not the copy).
      if (keptUnapplied) snapshots.set(id, stored)
      else snapshots.set(id, staged)
    }
    if (!listening) {
      listening = true
      window.addEventListener('focus', () => { void syncExternalEdits() })
    }
    toast.info(t('profiles.openedExternal'), keptUnapplied ? t('profiles.openedExternalKept') : t('profiles.openedExternalHint'))
  } catch (error) {
    toast.error(t('profiles.openFileFailed'), toProtocolError(error).message)
  }
}

/** Test seam: forget every watched profile. */
export function resetExternalProfileEdits(): void {
  snapshots.clear()
  baselines.clear()
  syncing = false
  pending = false
}

export { syncExternalEdits }
