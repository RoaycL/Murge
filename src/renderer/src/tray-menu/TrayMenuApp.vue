<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  Activity, AppWindow, Check, ChevronLeft, ChevronRight, CircleAlert, Cpu, Download, Files, FolderOpen, Globe2,
  Layers, Power, Route, ShieldCheck, Terminal
} from 'lucide-vue-next'
import type { Component } from 'vue'
import {
  EMPTY_MODEL, focusable, iconFor, isDanger, isSegmented, isSwitch, normalizeModel, pageHeight, resolvePage, splitLabel,
  type RowIcon, type TrayItem, type TrayModel
} from './model'

const model = ref<TrayModel>(EMPTY_MODEL)
const path = ref<string[]>([])
const focusedId = ref<string | null>(null)
const backdrop = typeof window.__MURGE_BACKDROP__ === 'string' ? window.__MURGE_BACKDROP__ : 'none'

const page = computed(() => resolvePage(model.value.items, path.value))
const items = computed(() => page.value.items)
const trail = computed(() => page.value.trail)
const parent = computed(() => trail.value[trail.value.length - 1] ?? null)

const icons: Record<Exclude<RowIcon, null>, Component> = {
  window: AppWindow, mode: Route, group: Layers, pulse: Activity, process: Cpu, proxy: Globe2, tun: ShieldCheck,
  terminal: Terminal, profile: Files, folder: FolderOpen, update: Download, quit: Power, warning: CircleAlert
}

function rowIcon(item: TrayItem): Component | null {
  if (path.value.length > 0) return null
  const name = iconFor(item)
  return name ? icons[name] : null
}

function activate(item: TrayItem): void {
  if (!item.enabled || item.kind === 'separator') return
  if (item.kind === 'submenu') {
    path.value = [...path.value, item.id]
    focusedId.value = null
    return
  }
  void invoke('tray_menu_activate', { id: item.id })
}

function back(): void {
  path.value = path.value.slice(0, -1)
  focusedId.value = null
}

function dismiss(): void {
  void invoke('tray_menu_dismiss')
}

function onKey(event: KeyboardEvent): void {
  const rows = focusable(items.value)
  const at = rows.findIndex((item) => item.id === focusedId.value)
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (!rows.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length
      focusedId.value = rows[next].id
      document.getElementById(rowDomId(rows[next]))?.scrollIntoView({ block: 'nearest' })
      break
    }
    case 'ArrowRight':
      if (at >= 0 && rows[at].kind === 'submenu') activate(rows[at])
      break
    case 'Enter':
    case ' ':
      if (at >= 0) activate(rows[at])
      break
    case 'ArrowLeft':
    case 'Backspace':
      if (path.value.length) back()
      break
    case 'Escape':
      if (path.value.length) back()
      else dismiss()
      break
    default:
      return
  }
  event.preventDefault()
}

function rowDomId(item: TrayItem): string {
  return `row-${encodeURIComponent(item.id)}`
}

function reportHeight(): void {
  void invoke('tray_menu_resize', { height: pageHeight(items.value) })
}

const accentClass = computed(() => `accent-${model.value.accent}`)

watch(() => model.value.theme, (theme) => {
  document.documentElement.dataset.theme = theme
}, { immediate: true })

watch([items, path], () => {
  void nextTick(reportHeight)
})

const unlisten: UnlistenFn[] = []

onMounted(async () => {
  document.documentElement.dataset.backdrop = backdrop
  window.addEventListener('keydown', onKey)
  unlisten.push(await listen('tray-menu:model', (event) => {
    model.value = normalizeModel(event.payload)
  }))
  unlisten.push(await listen('tray-menu:open', () => {
    path.value = []
    focusedId.value = null
    void nextTick(reportHeight)
  }))
  // Last: from here on the tray icon opens this page instead of the native menu.
  model.value = normalizeModel(await invoke('tray_menu_ready'))
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  for (const stop of unlisten) stop()
})
</script>

<template>
  <div class="panel" :class="accentClass" @contextmenu.prevent>
    <header v-if="!parent" class="header">
      <span class="status-dot" aria-hidden="true" />
      <div class="header-text">
        <span class="title">{{ model.title }}</span>
        <span class="status">{{ model.status }}</span>
      </div>
    </header>
    <header v-else class="header header-back">
      <button type="button" class="back" @click="back">
        <ChevronLeft :size="16" :stroke-width="2.2" />
        <span class="title">{{ splitLabel(parent.label).text }}</span>
      </button>
    </header>

    <div class="rows" role="menu">
      <template v-for="(item, index) in items" :key="item.id || `sep-${index}`">
        <div v-if="item.kind === 'separator'" class="separator" role="separator" />

        <div v-else-if="isSegmented(item)" class="row segmented-row" :class="{ disabled: !item.enabled }">
          <component :is="rowIcon(item)" v-if="rowIcon(item)" class="icon" :size="15" :stroke-width="1.9" />
          <div class="segmented" role="radiogroup" :aria-label="splitLabel(item.label).text">
            <button
              v-for="child in item.children"
              :key="child.id"
              type="button"
              role="radio"
              class="segment"
              :class="{ selected: child.checked }"
              :aria-checked="child.checked"
              :disabled="!item.enabled || !child.enabled"
              @click="activate(child)"
            >{{ child.label }}</button>
          </div>
        </div>

        <div
          v-else
          :id="rowDomId(item)"
          class="row"
          :class="{
            disabled: !item.enabled,
            focused: focusedId === item.id,
            danger: isDanger(item),
            plain: path.length > 0
          }"
          role="menuitem"
          :aria-disabled="!item.enabled"
          @mouseenter="item.enabled && (focusedId = item.id)"
          @mouseleave="focusedId === item.id && (focusedId = null)"
          @click="activate(item)"
        >
          <component :is="rowIcon(item)" v-if="rowIcon(item)" class="icon" :size="15" :stroke-width="1.9" />
          <span v-else-if="path.length > 0" class="check">
            <Check v-if="item.checked && (item.kind === 'radio' || item.kind === 'checkbox')" :size="14" :stroke-width="2.6" />
          </span>
          <span class="text">{{ splitLabel(item.label).text }}</span>
          <span v-if="splitLabel(item.label).detail" class="detail">{{ splitLabel(item.label).detail }}</span>
          <span
            v-if="isSwitch(item)"
            class="switch"
            :class="[{ on: item.checked }, `switch-${item.id}`]"
            aria-hidden="true"
          />
          <Check v-else-if="path.length === 0 && item.kind === 'checkbox' && item.checked" class="trail" :size="14" :stroke-width="2.6" />
          <ChevronRight v-if="item.kind === 'submenu'" class="trail chevron" :size="14" :stroke-width="2" />
        </div>
      </template>
    </div>
  </div>
</template>

<style>
:root {
  color-scheme: light;
  --tm-text: #1d1d1f;
  --tm-muted: rgba(60, 60, 67, 0.6);
  --tm-faint: rgba(60, 60, 67, 0.32);
  --tm-bg: rgba(250, 250, 252, 0.6);
  --tm-edge: rgba(255, 255, 255, 0.55);
  --tm-hairline: rgba(0, 0, 0, 0.09);
  --tm-highlight: #1587f8;
  --tm-on-highlight: #ffffff;
  --tm-track: rgba(118, 118, 128, 0.14);
  --tm-segment: #ffffff;
  --tm-segment-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 0 0 0.5px rgba(0, 0, 0, 0.06);
  --tm-switch-off: rgba(120, 120, 128, 0.26);
  --tm-danger: #e5484d;
  --tm-idle: #8e8e93;
  --tm-proxy: #34c759;
  --tm-tun: #0a84ff;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --tm-text: #f5f5f7;
  --tm-muted: rgba(235, 235, 245, 0.6);
  --tm-faint: rgba(235, 235, 245, 0.3);
  --tm-bg: rgba(34, 36, 44, 0.56);
  --tm-edge: rgba(255, 255, 255, 0.1);
  --tm-hairline: rgba(255, 255, 255, 0.09);
  --tm-highlight: #0a84ff;
  --tm-track: rgba(118, 118, 128, 0.24);
  --tm-segment: rgba(255, 255, 255, 0.2);
  --tm-segment-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  --tm-switch-off: rgba(120, 120, 128, 0.36);
}

/* No DWM backdrop (Windows 10): an opaque panel, never a see-through one. */
:root[data-backdrop="none"] { --tm-bg: #f6f7f9; }
:root[data-backdrop="none"][data-theme="dark"] { --tm-bg: #26282f; }

html, body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: transparent;
  font-family: "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  color: var(--tm-text);
  -webkit-font-smoothing: antialiased;
  user-select: none;
  cursor: default;
}

#tray-menu { height: 100%; }
</style>

<style scoped>
.panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0 6px 6px;
  border-radius: 8px;
  background: var(--tm-bg);
  box-shadow: inset 0 0 0 0.5px var(--tm-edge), inset 0 1px 0 var(--tm-edge);
  overflow: hidden;
  --tm-accent: var(--tm-idle);
}
.panel.accent-proxy { --tm-accent: var(--tm-proxy); }
.panel.accent-tun { --tm-accent: var(--tm-tun); }

.header {
  flex: 0 0 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 0;
  box-sizing: border-box;
  border-bottom: 0.5px solid var(--tm-hairline);
  margin: 0 -6px 6px;
  padding-left: 16px;
}
.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--tm-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tm-accent) 22%, transparent), 0 0 10px color-mix(in srgb, var(--tm-accent) 55%, transparent);
  flex: none;
}
.header-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.title { font-size: 13.5px; font-weight: 600; letter-spacing: 0.1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status { font-size: 11.5px; color: var(--tm-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.header-back { padding-left: 8px; }
.back {
  all: unset;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 8px 0 4px;
  border-radius: 6px;
  color: var(--tm-text);
  min-width: 0;
}
.back:hover { background: var(--tm-track); }
.back:focus-visible { outline: 2px solid var(--tm-highlight); }

.rows {
  flex: 1 1 auto;
  overflow-y: auto;
  scrollbar-width: none;
}
.rows::-webkit-scrollbar { display: none; }

.separator {
  height: 0.5px;
  margin: 4px 10px 4.5px;
  background: var(--tm-hairline);
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  white-space: nowrap;
  transition: background-color 80ms ease-out;
}
.row.plain { padding-left: 6px; gap: 6px; }
.row.focused:not(.disabled) {
  background: var(--tm-highlight);
  color: var(--tm-on-highlight);
}
.row.focused:not(.disabled) .icon,
.row.focused:not(.disabled) .detail,
.row.focused:not(.disabled) .trail { color: var(--tm-on-highlight); }
.row.disabled { color: var(--tm-faint); }
.row.disabled .icon { color: var(--tm-faint); }
.row.danger:not(.disabled) { color: var(--tm-danger); }
.row.danger .icon { color: var(--tm-danger); }
.row.danger.focused:not(.disabled) { background: var(--tm-danger); color: #fff; }
.row.danger.focused:not(.disabled) .icon { color: #fff; }

.icon { flex: none; color: var(--tm-muted); }
.check { flex: none; width: 16px; display: inline-flex; justify-content: center; color: var(--tm-highlight); }
.row.focused:not(.disabled) .check { color: var(--tm-on-highlight); }
.text { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.detail {
  flex: 1 1 auto;
  min-width: 0;
  text-align: right;
  color: var(--tm-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row.disabled .detail { color: var(--tm-faint); }
.trail { flex: none; color: var(--tm-muted); margin-left: auto; }
.detail + .trail { margin-left: 0; }
.chevron { opacity: 0.8; }

.switch {
  flex: none;
  position: relative;
  width: 30px;
  height: 18px;
  margin-left: auto;
  border-radius: 9px;
  background: var(--tm-switch-off);
  transition: background-color 140ms ease;
}
.switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 140ms ease;
}
.switch.on { background: var(--tm-proxy); }
.switch.on.switch-tun { background: var(--tm-tun); }
.switch.on::after { transform: translateX(12px); }
.row.focused:not(.disabled) .switch:not(.on) { background: rgba(255, 255, 255, 0.35); }
.row.focused:not(.disabled) .switch.on { box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.85); }
.row.disabled .switch { opacity: 0.45; }

.segmented-row { padding-right: 8px; }
.segmented {
  flex: 1 1 auto;
  display: flex;
  gap: 2px;
  height: 24px;
  padding: 2px;
  box-sizing: border-box;
  border-radius: 7px;
  background: var(--tm-track);
}
.segment {
  all: unset;
  flex: 1 1 0;
  text-align: center;
  font-size: 12px;
  line-height: 20px;
  border-radius: 5px;
  color: var(--tm-text);
  transition: background-color 120ms ease;
}
.segment:hover:not(:disabled):not(.selected) { background: color-mix(in srgb, var(--tm-segment) 45%, transparent); }
.segment.selected { background: var(--tm-segment); box-shadow: var(--tm-segment-shadow); font-weight: 600; }
.segment:disabled { color: var(--tm-faint); }
.segment:focus-visible { outline: 2px solid var(--tm-highlight); outline-offset: -1px; }
.segmented-row.disabled .icon { color: var(--tm-faint); }
</style>
