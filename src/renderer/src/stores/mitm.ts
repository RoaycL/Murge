import { ref } from 'vue'
import { defineStore } from 'pinia'
import { EMPTY_MITM_STATE, type MitmRequestEntry, type MitmState } from '@shared/mitm'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * HTTPS 解密 + 重写 state. Every mutation round-trips through IPC and then
 * re-reads the authoritative snapshot from the Rust service.
 */
export const useMitmStore = defineStore('mitm', () => {
  const state = ref<MitmState>(structuredClone(EMPTY_MITM_STATE))
  const requests = ref<MitmRequestEntry[]>([])
  const loaded = ref(false)
  const busy = ref<string | null>(null)
  const lastError = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      state.value = await window.desktop.mitm.getState()
      loaded.value = true
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  async function refreshRequests(): Promise<void> {
    try {
      requests.value = await window.desktop.mitm.recentRequests()
    } catch {
      // The list is best-effort; the page keeps the previous rows.
    }
  }

  /** Run one mutation; returns the error message (null on success). */
  async function run(label: string, action: () => Promise<unknown>): Promise<string | null> {
    if (busy.value) return '正在处理上一个操作'
    busy.value = label
    try {
      await action()
      lastError.value = null
      return null
    } catch (error) {
      const message = toProtocolError(error).message
      lastError.value = message
      return message
    } finally {
      busy.value = null
      await refresh()
    }
  }

  const api = () => window.desktop.mitm

  return {
    state,
    requests,
    loaded,
    busy,
    lastError,
    refresh,
    refreshRequests,
    setEnabled: (enabled: boolean) => run('enabled', () => api().setEnabled(enabled)),
    setRewriteEnabled: (enabled: boolean) => run('rewrite', () => api().setRewriteEnabled(enabled)),
    setSkipVerify: (skip: boolean) => run('skip-verify', () => api().setSkipVerify(skip)),
    setHostnames: (hostnames: string[]) => run('hostnames', () => api().setHostnames(hostnames)),
    setLocalModule: (content: string) => run('local-module', () => api().setLocalModule(content)),
    generateCa: () => run('generate-ca', () => api().generateCa()),
    installCa: () => run('install-ca', () => api().installCa()),
    uninstallCa: () => run('uninstall-ca', () => api().uninstallCa()),
    deleteCa: () => run('delete-ca', () => api().deleteCa()),
    exportCa: () => run('export-ca', () => api().exportCa()),
    addModule: (url: string) => run('add-module', () => api().addModule(url)),
    updateModule: (id: string) => run(`update-${id}`, () => api().updateModule(id)),
    removeModule: (id: string) => run(`remove-${id}`, () => api().removeModule(id)),
    setModuleEnabled: (id: string, enabled: boolean) => run(`toggle-${id}`, () => api().setModuleEnabled(id, enabled)),
    clearRequests: async () => {
      await run('clear', () => api().clearRequests())
      await refreshRequests()
    }
  }
})
