import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue'

const dirtyForms = reactive(new Map<string, string>())
const pendingTarget = ref<string | null>(null)
let bypassTarget: string | null = null

export const hasUnsavedChanges = computed(() => dirtyForms.size > 0)
export const unsavedLabels = computed(() => [...new Set(dirtyForms.values())])
export const pendingNavigation = pendingTarget

export function setUnsavedChange(id: string, label: string): void {
  dirtyForms.set(id, label)
}

export function clearUnsavedChange(id: string): void {
  dirtyForms.delete(id)
}

export function useUnsavedChanges(id: string, label: string, dirty: Ref<boolean>): void {
  watch(dirty, (value) => value ? setUnsavedChange(id, label) : clearUnsavedChange(id), { immediate: true })
  onBeforeUnmount(() => clearUnsavedChange(id))
}

export function requestNavigation(target: string): void {
  pendingTarget.value = target
}

export function cancelNavigation(): void {
  pendingTarget.value = null
}

export function approveNavigation(): string | null {
  const target = pendingTarget.value
  if (!target) return null
  pendingTarget.value = null
  bypassTarget = target
  return target
}

export function consumeNavigationBypass(target: string): boolean {
  if (bypassTarget !== target) return false
  bypassTarget = null
  return true
}
