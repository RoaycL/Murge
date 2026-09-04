<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import AppIcon from './AppIcon.vue'

export interface AppSelectOption {
  value: string
  label: string
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: readonly AppSelectOption[]
  label: string
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const open = ref(false)
const activeIndex = ref(0)
const selected = computed(() => props.options.find((item) => item.value === props.modelValue))

function close(restoreFocus = false): void {
  open.value = false
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function openMenu(): void {
  if (props.disabled) return
  const index = props.options.findIndex((item) => item.value === props.modelValue)
  activeIndex.value = Math.max(0, index)
  open.value = true
}

function toggle(): void {
  open.value ? close() : openMenu()
}

function choose(option: AppSelectOption): void {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  close(true)
}

function move(step: number): void {
  if (!open.value) openMenu()
  if (!props.options.length) return
  let next = activeIndex.value
  for (let count = 0; count < props.options.length; count += 1) {
    next = (next + step + props.options.length) % props.options.length
    if (!props.options[next]?.disabled) break
  }
  activeIndex.value = next
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); close(true); return }
  if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return }
  if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return }
  if ((event.key === 'Enter' || event.key === ' ') && open.value) {
    event.preventDefault()
    const option = props.options[activeIndex.value]
    if (option) choose(option)
  }
}

function onDocumentPointer(event: PointerEvent): void {
  if (open.value && !root.value?.contains(event.target as Node)) close()
}

document.addEventListener('pointerdown', onDocumentPointer)
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointer))
</script>

<template>
  <div ref="root" class="app-select" :class="{ open, disabled }" @keydown="onKeydown">
    <button ref="trigger" type="button" class="app-select-trigger" :disabled="disabled" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open" @click="toggle">
      <span>{{ selected?.label ?? modelValue }}</span><AppIcon name="chevron-down" :size="15" />
    </button>
    <div v-if="open" class="app-select-menu" role="listbox" :aria-label="label">
      <button v-for="(option, index) in options" :key="option.value" type="button" role="option" :aria-selected="option.value === modelValue" :disabled="option.disabled" :class="{ active: index === activeIndex, selected: option.value === modelValue }" @mouseenter="activeIndex = index" @click="choose(option)">
        <span>{{ option.label }}</span><AppIcon v-if="option.value === modelValue" name="check" :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.app-select { position: relative; min-width: 132px; font-size: 12px; }
.app-select-trigger { display: flex; width: 100%; min-height: 32px; align-items: center; justify-content: space-between; gap: 12px; padding: 0 10px 0 12px; border: 1px solid var(--app-divider); border-radius: 8px; background: color-mix(in srgb, var(--app-surface) 88%, var(--app-bg)); color: var(--app-text); text-align: left; }
.app-select-trigger:hover:not(:disabled), .app-select.open .app-select-trigger { border-color: color-mix(in srgb, var(--app-blue) 55%, var(--app-divider)); background: color-mix(in srgb, var(--app-blue) 7%, var(--app-surface)); }
.app-select-trigger:focus-visible { outline: 2px solid color-mix(in srgb, var(--app-blue) 55%, transparent); outline-offset: 2px; }
.app-select-trigger svg { flex: none; color: var(--app-muted); transition: transform .16s ease; }
.app-select.open .app-select-trigger svg { transform: rotate(180deg); }
.app-select-menu { position: absolute; z-index: 120; top: calc(100% + 5px); right: 0; min-width: 100%; max-height: 248px; overflow: auto; padding: 5px; border: 1px solid var(--app-divider); border-radius: 9px; background: color-mix(in srgb, var(--app-surface) 96%, var(--app-bg)); box-shadow: 0 12px 32px rgba(0,0,0,.22); }
.app-select-menu button { display: flex; width: 100%; min-height: 30px; align-items: center; justify-content: space-between; gap: 16px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--app-text); white-space: nowrap; text-align: left; }
.app-select-menu button.active { background: rgba(127,127,127,.11); }
.app-select-menu button.selected { color: var(--app-blue); }
.app-select-menu button:disabled { opacity: .42; }
.app-select.disabled { opacity: .52; }
</style>
