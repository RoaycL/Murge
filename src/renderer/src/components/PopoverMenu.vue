<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/**
 * A menu shown at a point (right-click position or under a button). It is
 * clamped to the viewport and closes on outside click, Escape, scroll or
 * resize. Items are slotted; use `.popover-item` buttons and `.popover-sep`.
 */
const props = defineProps<{ open: boolean; x: number; y: number; label?: string }>()
const emit = defineEmits<{ close: [] }>()

const menu = ref<HTMLElement | null>(null)
const left = ref(0)
const top = ref(0)
const MARGIN = 8

function place(): void {
  const el = menu.value
  const width = el?.offsetWidth ?? 0
  const height = el?.offsetHeight ?? 0
  left.value = Math.max(MARGIN, Math.min(props.x, window.innerWidth - width - MARGIN))
  top.value = Math.max(MARGIN, Math.min(props.y, window.innerHeight - height - MARGIN))
}

function close(): void {
  emit('close')
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

function listen(on: boolean): void {
  if (on) {
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
  } else {
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', close)
    window.removeEventListener('scroll', close, true)
  }
}

watch(
  () => [props.open, props.x, props.y] as const,
  async ([open]) => {
    listen(false)
    if (!open) return
    left.value = props.x
    top.value = props.y
    await nextTick()
    place()
    menu.value?.querySelector<HTMLElement>('.popover-item:not(:disabled)')?.focus({ preventScroll: true })
    listen(true)
  }
)

onBeforeUnmount(() => listen(false))
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="popover-shade" @pointerdown="close" @contextmenu.prevent="close" />
      <div ref="menu" class="popover-menu" role="menu" :aria-label="label" :style="{ left: `${left}px`, top: `${top}px` }" @click="close">
        <slot />
      </div>
    </template>
  </Teleport>
</template>

<style>
.popover-shade { position: fixed; z-index: 2990; inset: 0; }
.popover-menu { position: fixed; z-index: 3000; display: grid; min-width: 220px; max-width: min(340px, calc(100vw - 16px)); padding: 5px; border: 1px solid var(--glass-edge); border-radius: 12px; color: var(--app-text); background: var(--glass-bg); -webkit-backdrop-filter: var(--glass-filter); backdrop-filter: var(--glass-filter); box-shadow: var(--glass-shadow); font-size: var(--font-size-sm); animation: popover-in 0.12s ease-out; }
.popover-flyout { z-index: 3001; min-width: 250px; }
@keyframes popover-in { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .popover-menu { animation: none; } }
.popover-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; padding: 4px 10px; border: 0; border-radius: 6px; background: transparent; color: inherit; font-size: var(--font-size-sm); text-align: left; cursor: default; }
.popover-item:hover:not(:disabled), .popover-item:focus-visible, .popover-item.active { outline: none; color: var(--app-on-accent); background: var(--app-blue); }
.popover-item:disabled { opacity: 0.45; }
.popover-item.danger:not(:hover):not(:focus-visible) { color: var(--app-danger); }
.popover-sub i { font-size: 15px; font-style: normal; line-height: 1; opacity: 0.7; }
.popover-sep { height: 1px; margin: 4px 10px; background: var(--app-divider); }
.popover-section { padding: 6px 10px 2px; color: var(--app-muted); font-size: var(--font-size-2xs); font-weight: 600; }
.popover-info { display: block; overflow: hidden; padding: 2px 10px; color: var(--app-muted); font-size: var(--font-size-sm); text-overflow: ellipsis; white-space: nowrap; }
</style>
