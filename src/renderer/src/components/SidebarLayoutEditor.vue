<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { useSidebarLayoutStore } from '../stores/sidebar-layout'
import { SIDEBAR_GROUPS, sidebarItem, type SidebarGroupId, type SidebarItemId } from '../lib/sidebar-layout'

const store = useSidebarLayoutStore()

const sections = computed(() => SIDEBAR_GROUPS.map((group) => ({
  id: group.id,
  label: group.settingsLabel,
  rows: store.layout[group.id].map((entry) => ({ ...sidebarItem(entry.id), visible: entry.visible }))
})))

// 拖动只在当前分组内重排：指针越过相邻行的一半时交换位置，被拖动的行跟随指针平移。
interface DragState { group: SidebarGroupId; id: SidebarItemId; index: number; originY: number; rowHeight: number; pointerId: number }
const drag = ref<DragState | null>(null)
const dragOffset = ref(0)

function onPointerDown(event: PointerEvent, group: SidebarGroupId, id: SidebarItemId, index: number): void {
  if (event.button !== 0) return
  const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('.layout-row')
  if (!row) return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  drag.value = { group, id, index, originY: event.clientY, rowHeight: row.getBoundingClientRect().height, pointerId: event.pointerId }
  dragOffset.value = 0
}

function onPointerMove(event: PointerEvent): void {
  const state = drag.value
  if (!state || event.pointerId !== state.pointerId) return
  const count = store.layout[state.group].length
  let offset = event.clientY - state.originY
  while (offset > state.rowHeight / 2 && state.index < count - 1) {
    store.move(state.group, state.index, state.index + 1)
    state.index += 1
    state.originY += state.rowHeight
    offset -= state.rowHeight
  }
  while (offset < -state.rowHeight / 2 && state.index > 0) {
    store.move(state.group, state.index, state.index - 1)
    state.index -= 1
    state.originY -= state.rowHeight
    offset += state.rowHeight
  }
  // 首尾不再继续拖出分组。
  const min = -state.index * state.rowHeight
  const max = (count - 1 - state.index) * state.rowHeight
  dragOffset.value = Math.max(min - 6, Math.min(max + 6, offset))
}

function onPointerUp(event: PointerEvent): void {
  if (!drag.value || event.pointerId !== drag.value.pointerId) return
  drag.value = null
  dragOffset.value = 0
}

async function onHandleKey(event: KeyboardEvent, group: SidebarGroupId, id: SidebarItemId, index: number): Promise<void> {
  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
  if (!delta) return
  event.preventDefault()
  const target = index + delta
  if (target < 0 || target >= store.layout[group].length) return
  store.move(group, index, target)
  await nextTick()
  document.querySelector<HTMLElement>(`.layout-row[data-item="${id}"] .layout-handle`)?.focus()
}

function rowStyle(id: SidebarItemId): Record<string, string> | undefined {
  return drag.value?.id === id ? { transform: `translateY(${dragOffset.value}px)` } : undefined
}
</script>

<template>
  <div class="sidebar-layout-editor" :class="{ dragging: Boolean(drag) }">
    <div v-for="section in sections" :key="section.id" class="layout-group">
      <h3>{{ section.label }}</h3>
      <ol class="surface-card layout-list" :aria-label="`${section.label}分组`">
        <li
          v-for="(row, index) in section.rows"
          :key="row.id"
          class="layout-row"
          :class="{ lifted: drag?.id === row.id, muted: !row.visible }"
          :data-item="row.id"
          :style="rowStyle(row.id)"
        >
          <button
            type="button"
            class="layout-handle"
            :aria-label="`拖动调整「${row.label}」的位置，或用上下方向键移动`"
            title="拖动排序"
            @pointerdown="onPointerDown($event, section.id, row.id, index)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @keydown="onHandleKey($event, section.id, row.id, index)"
          ><AppIcon name="grip" :size="15" /></button>
          <span class="layout-icon"><AppIcon :name="row.icon" :size="16" /></span>
          <strong>{{ row.label }}</strong>
          <small v-if="!row.visible">在「更多」中</small>
          <button
            type="button"
            class="switch"
            :class="{ on: row.visible }"
            role="switch"
            :aria-checked="row.visible"
            :aria-label="`在侧边栏显示${row.label}`"
            @click="store.setVisible(row.id, !row.visible)"
          />
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.sidebar-layout-editor { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: 16px 15px; }
.layout-group h3 { margin: 0 0 7px 2px; color: var(--app-muted); font-size: var(--font-size-sm); font-weight: var(--font-weight-regular); }
.layout-list { margin: 0; padding: 0; list-style: none; border-radius: var(--radius-md); }
.layout-row { position: relative; display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 14px 0 6px; border-bottom: 1px solid var(--app-divider); background: transparent; transition: background-color 120ms ease, box-shadow 120ms ease; }
.layout-row:last-child { border-bottom: 0; }
.layout-row strong { flex: 1 1 auto; min-width: 0; font-size: var(--font-size-md); font-weight: var(--font-weight-regular); }
.layout-row small { color: var(--app-muted); font-size: var(--font-size-2xs); white-space: nowrap; }
.layout-row.muted strong, .layout-row.muted .layout-icon { opacity: .55; }
.layout-row.lifted { z-index: 2; border-bottom-color: transparent; border-radius: var(--radius-md); background: var(--glass-bg, var(--app-surface-solid)); -webkit-backdrop-filter: var(--glass-filter, none); backdrop-filter: var(--glass-filter, none); box-shadow: 0 0 0 .5px rgba(20, 26, 38, .14), 0 8px 22px rgba(20, 26, 38, .16); transition: none; }
.layout-handle { display: grid; place-items: center; flex: 0 0 auto; width: 24px; height: 30px; padding: 0; border: 0; border-radius: 6px; color: var(--app-muted); background: transparent; cursor: grab; touch-action: none; }
.layout-handle:hover { background: var(--app-fill-subtle); color: var(--app-text); }
.dragging, .dragging .layout-handle { cursor: grabbing; }
.dragging .layout-row:not(.lifted) { transition: none; }
.layout-icon { display: grid; place-items: center; flex: 0 0 26px; width: 26px; height: 26px; border: 1px solid var(--app-divider); border-radius: 7px; color: var(--app-text); background: color-mix(in srgb, var(--app-surface-solid) 92%, var(--app-muted)); }
:root[data-reduce-motion="true"] .layout-row { transition: none; }
</style>
