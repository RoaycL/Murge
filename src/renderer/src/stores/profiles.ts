import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ProfileSubscription, ValidationResult } from '@shared/profiles'
import { toProtocolError } from '@shared/protocol-errors'

export type ProfilesStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Profile/subscription management store. It talks only to the trusted profile
 * gateway (never to a file or URL directly), so imported documents and edits
 * always pass the main-process validator and never carry credentials into the
 * renderer.
 */
export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<ProfileMeta[]>([])
  const detail = ref<Profile | null>(null)
  const currentId = ref<string | null>(null)
  const status = ref<ProfilesStatus>('idle')
  const lastError = ref<string | null>(null)

  const active = computed<ProfileMeta | null>(() => profiles.value.find((meta) => meta.active) ?? null)
  const ordered = computed<ProfileMeta[]>(() =>
    [...profiles.value].sort((a, b) => a.createdAt - b.createdAt)
  )

  async function load(): Promise<void> {
    status.value = 'loading'
    lastError.value = null
    try {
      profiles.value = await window.desktop.profiles.list()
      currentId.value = profiles.value.find((meta) => meta.active)?.id ?? null
      status.value = 'ready'
    } catch (error) {
      lastError.value = toProtocolError(error).message
      profiles.value = []
      status.value = 'error'
    }
  }

  async function get(id: string): Promise<Profile | null> {
    try {
      detail.value = await window.desktop.profiles.get(id)
      return detail.value
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return null
    }
  }

  async function importFromUrl(name: string, url: string, activate = false): Promise<void> {
    await mutate(() => window.desktop.profiles.importFromUrl(name, url, activate))
    await load()
  }

  /** Re-fetch a URL-backed profile's subscription and replace its document. */
  async function updateFromSource(id: string): Promise<void> {
    await mutate(() => window.desktop.profiles.updateFromSource(id))
    await load()
  }

  async function importProfile(request: ImportRequest): Promise<void> {
    await mutate(() => window.desktop.profiles.import(request))
    await load()
  }

  async function activate(id: string): Promise<void> {
    await mutate(() => window.desktop.profiles.activate(id))
    await load()
  }

  async function remove(id: string): Promise<void> {
    await mutate(() => window.desktop.profiles.delete(id))
    await load()
  }

  async function rename(id: string, name: string): Promise<void> {
    await mutate(() => window.desktop.profiles.rename(id, name))
    await load()
  }

  async function editDocument(id: string, edits: ConfigEdit[]): Promise<void> {
    await mutate(() => window.desktop.profiles.editDocument(id, edits))
    await load()
    await get(id)
  }

  async function replaceDocument(id: string, document: string): Promise<void> {
    await mutate(() => window.desktop.profiles.replaceDocument(id, document))
    await load(); await get(id)
  }

  async function getSourceUrl(id: string): Promise<string | null> {
    return window.desktop.profiles.getSourceUrl(id)
  }

  async function setSourceUrl(id: string, url: string): Promise<void> {
    await mutate(() => window.desktop.profiles.setSourceUrl(id, url)); await load()
  }

  async function validate(document: string): Promise<ValidationResult> {
    try {
      return await window.desktop.profiles.validate(document)
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return { ok: false, issues: [{ severity: 'error', message: lastError.value }] }
    }
  }

  /** Run a mutating gateway call; surface any failure as the store error. */
  async function mutate(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation()
    } catch (error) {
      lastError.value = toProtocolError(error).message
      throw error
    }
  }

  function clear(): void {
    profiles.value = []
    detail.value = null
    currentId.value = null
    status.value = 'idle'
    lastError.value = null
  }

  return {
    profiles,
    detail,
    currentId,
    status,
    lastError,
    active,
    ordered,
    load,
    get,
    importFromUrl,
    updateFromSource,
    importProfile,
    activate,
    remove,
    rename,
    editDocument,
    replaceDocument,
    getSourceUrl,
    setSourceUrl,
    validate,
    clear
  }
})

export type { ProfileMeta, ProfileSubscription }
