<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'

/**
 * A "Label ›" row inside a PopoverMenu that opens a flyout beside the menu,
 * like a macOS submenu. The flyout is teleported to <body> so its own
 * backdrop blur sees the page (a blur nested in the menu's would not).
 */
defineProps<{ label: string }>()

const trigger = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const open = ref(false)
const left = ref(0)
const top = ref(0)
const MARGIN = 8
let timer: ReturnType<typeof setTimeout> | null = null

function cancelClose(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

async function show(): Promise<void> {
  cancelClose()
  if (open.value) return
  open.value = true
  const rect = trigger.value?.closest('.popover-menu')?.getBoundingClientRect() ?? trigger.value?.getBoundingClientRect()
  const row = trigger.value?.getBoundingClientRect()
  if (!rect || !row) return
  left.value = rect.right + 4
  top.value = row.top - 6
  await nextTick()
  const width = panel.value?.offsetWidth ?? 0
  const height = panel.value?.offsetHeight ?? 0
  if (left.value + width + MARGIN > window.innerWidth) left.value = Math.max(MARGIN, rect.left - width - 4)
  top.value = Math.max(MARGIN, Math.min(top.value, window.innerHeight - height - MARGIN))
}

function hideSoon(): void {
  cancelClose()
  timer = setTimeout(() => {
    open.value = false
  }, 160)
}

onBeforeUnmount(cancelClose)
</script>

<template>
  <button ref="trigger" type="button" class="popover-item popover-sub" :class="{ active: open }" role="menuitem" aria-haspopup="menu" :aria-expanded="open" @mouseenter="show" @mouseleave="hideSoon" @focus="show" @click.stop="show">
    <span>{{ label }}</span><i aria-hidden="true">›</i>
  </button>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="popover-menu popover-flyout" role="menu" :aria-label="label" :style="{ left: `${left}px`, top: `${top}px` }" @mouseenter="cancelClose" @mouseleave="hideSoon" @click.stop>
      <slot />
    </div>
  </Teleport>
</template>
