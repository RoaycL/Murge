<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

/**
 * Surge 式「…」更多菜单：圆形小按钮，点击后在按钮下方右对齐弹出菜单。
 * 菜单项由默认插槽提供（button role="menuitem"），点任意菜单项或空白处、按 Esc 关闭。
 */
defineProps<{ label: string }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

function close(): void { open.value = false }
function onPointerDown(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) close()
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}
watch(open, (value) => {
  if (value) {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeydown)
  } else {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeydown)
  }
})
onBeforeUnmount(close)
</script>

<template>
  <div ref="root" class="overflow-menu">
    <button type="button" class="overflow-menu-trigger" :aria-label="label" aria-haspopup="menu" :aria-expanded="open" @click="open = !open">
      <AppIcon name="more-horizontal" :size="14" :stroke-width="2.4" />
    </button>
    <div v-if="open" class="overflow-menu-list" role="menu" @click="close">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.overflow-menu { position: relative; flex: none; }
.overflow-menu-trigger { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: var(--app-fill-strong); color: var(--app-surface-solid); cursor: pointer; }
.overflow-menu-trigger:hover, .overflow-menu-trigger[aria-expanded="true"] { background: var(--app-muted); }
.overflow-menu-list { position: absolute; z-index: 20; top: calc(100% + 6px); right: 0; display: flex; flex-direction: column; min-width: 168px; padding: 5px; border: 1px solid var(--app-divider); border-radius: var(--radius-md); background: var(--app-surface-solid); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16); }
.overflow-menu-list :slotted(button) { padding: 7px 10px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--app-text); font-size: var(--font-size-sm); text-align: left; white-space: nowrap; cursor: pointer; }
.overflow-menu-list :slotted(button:hover:not(:disabled)) { background: var(--app-fill); }
.overflow-menu-list :slotted(button.danger) { color: var(--app-danger); }
.overflow-menu-list :slotted(button:disabled) { opacity: 0.5; cursor: default; }
</style>
