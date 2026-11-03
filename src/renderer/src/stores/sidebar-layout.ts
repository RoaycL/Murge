import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  SIDEBAR_LAYOUT_STORAGE_KEY, defaultSidebarLayout, hiddenSidebarItems, isDefaultSidebarLayout, moveWithinGroup,
  parseSidebarLayout, setItemVisible, visibleSidebarGroups,
  type SidebarGroupId, type SidebarItemId, type SidebarLayout
} from '../lib/sidebar-layout'

function readStored(): string | null {
  try { return window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY) } catch { return null }
}

export const useSidebarLayoutStore = defineStore('sidebar-layout', () => {
  const layout = ref<SidebarLayout>(parseSidebarLayout(readStored()))
  const groups = computed(() => visibleSidebarGroups(layout.value))
  const hidden = computed(() => hiddenSidebarItems(layout.value))
  const isDefault = computed(() => isDefaultSidebarLayout(layout.value))

  function commit(next: SidebarLayout): void {
    layout.value = next
    try { window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify(next)) } catch { /* 存不下时本次会话仍生效 */ }
  }

  function move(group: SidebarGroupId, from: number, to: number): void { commit(moveWithinGroup(layout.value, group, from, to)) }
  function setVisible(id: SidebarItemId, visible: boolean): void { commit(setItemVisible(layout.value, id, visible)) }
  function isVisible(id: SidebarItemId): boolean {
    return Object.values(layout.value).some((entries) => entries.some((entry) => entry.id === id && entry.visible))
  }
  function reset(): void { commit(defaultSidebarLayout()) }

  return { layout, groups, hidden, isDefault, move, setVisible, isVisible, reset }
})
