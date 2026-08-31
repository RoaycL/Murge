import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type { OverrideInput, OverridesSnapshot } from '@shared/overrides'
import { EMPTY_OVERRIDES, coerceOverridesSnapshot } from '@shared/overrides'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * Renderer-side source of truth for the override (增强/覆写) chain. Every
 * mutation round-trips through IPC and reconciles with the authoritative
 * snapshot returned by the main process, so the list stays consistent.
 */
export const useOverridesStore = defineStore('overrides', () => {
  const snapshot = ref<OverridesSnapshot>({ ...EMPTY_OVERRIDES })
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  /** Items in application order (ascending `order`). */
  const items = computed(() => [...snapshot.value.items].sort((a, b) => a.order - b.order))

  async function refresh(): Promise<void> {
    try {
      snapshot.value = coerceOverridesSnapshot(await window.desktop.overrides.list())
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  async function create(input: OverrideInput): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      snapshot.value = coerceOverridesSnapshot(await window.desktop.overrides.create(input))
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function update(id: string, input: OverrideInput): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      snapshot.value = coerceOverridesSnapshot(await window.desktop.overrides.update(id, input))
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function remove(id: string): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      snapshot.value = coerceOverridesSnapshot(await window.desktop.overrides.remove(id))
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      snapshot.value = coerceOverridesSnapshot(await window.desktop.overrides.setEnabled(id, enabled))
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function move(id: string, direction: 'up' | 'down'): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    try {
      snapshot.value = coerceOverridesSnapshot(await window.desktop.overrides.move(id, direction))
      lastError.value = null
      return true
    } catch (error) {
      lastError.value = toProtocolError(error).message
      return false
    } finally {
      busy.value = false
    }
  }

  return { snapshot, items, busy, lastError, refresh, create, update, remove, setEnabled, move }
})
