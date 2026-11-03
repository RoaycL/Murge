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
.popover-menu { position: fixed; z-index: 3000; display: grid; min-width: 220px; max-width: min(340px, calc(100vw - 16px)); padding: 5px; border: 1px solid color-mix(in srgb, var(--app-divider) 84%, white 16%); border-radius: var(--radius-panel); color: var(--app-text); background: var(--app-popover); -webkit-backdrop-filter: var(--app-popover-filter); backdrop-filter: var(--app-popover-filter); box-shadow: 0 18px 38px rgba(0, 0, 0, 0.3); font-size: var(--font-size-sm); }
.popover-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 10px; border: 0; border-radius: 6px; background: transparent; color: inherit; font-size: var(--font-size-sm); text-align: left; cursor: default; }
.popover-item:hover:not(:disabled), .popover-item:focus-visible { outline: none; color: var(--app-on-accent); background: var(--app-blue); }
.popover-item:disabled { opacity: 0.45; }
.popover-item.danger:not(:hover):not(:focus-visible) { color: var(--app-danger); }
.popover-sep { height: 1px; margin: 4px 6px; background: var(--app-divider); }
</style>
