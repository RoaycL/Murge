<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import RefreshIndicator from './RefreshIndicator.vue'

/**
 * Plain-text 「全部更新」 button shared by 外部资源 and 规则. Runs the batch itself so it
 * can show the outcome on the button (已全部更新 / N 项失败) for a moment
 * after the work ends, instead of silently flipping back to the idle label. The glyph only
 * appears while working / reporting, so the idle button stays plain text.
 */
const props = withDefaults(defineProps<{
  run: () => Promise<{ updated: number; failed: number }>
  disabled?: boolean
  label?: string
}>(), { disabled: false, label: '全部更新' })

const busy = ref(false)
const outcome = ref<{ updated: number; failed: number } | null>(null)
let settle: number | null = null

const text = computed(() => {
  if (busy.value) return '更新中…'
  if (outcome.value) return outcome.value.failed ? `${outcome.value.failed} 项失败` : '已全部更新'
  return props.label
})

async function onClick(): Promise<void> {
  if (busy.value) return
  if (settle != null) window.clearTimeout(settle)
  outcome.value = null
  busy.value = true
  let result = { updated: 0, failed: 0 }
  try {
    result = await props.run()
  } catch {
    result = { updated: 0, failed: 1 }
  } finally {
    outcome.value = result
    busy.value = false
    // Matches RefreshIndicator's settle so the glyph leaves with the result text.
    settle = window.setTimeout(() => { outcome.value = null; settle = null }, result.failed ? 1600 : 1300)
  }
}
onUnmounted(() => { if (settle != null) window.clearTimeout(settle) })
</script>

<template>
  <button
    type="button"
    class="refresh-all-button"
    :class="{ busy, done: outcome && !outcome.failed && !busy, failed: outcome?.failed && !busy }"
    :disabled="disabled && !busy"
    :aria-busy="busy"
    @click="onClick"
  >
    <Transition name="rab-glyph"><RefreshIndicator v-if="busy || outcome" :busy="busy" :failed="Boolean(outcome?.failed)" :size="14" /></Transition>
    <span aria-live="polite">{{ text }}</span>
  </button>
</template>

<style scoped>
.refresh-all-button {
  position: relative; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px;
  overflow: hidden; border: 1px solid var(--app-divider); border-radius: var(--radius-control);
  background: var(--app-surface-solid, transparent); color: var(--app-text); font-size: var(--font-size-xs);
  white-space: nowrap; cursor: pointer; transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}
.refresh-all-button:hover:not(:disabled):not(.busy) { background: var(--app-fill); }
.refresh-all-button:disabled { opacity: .5; cursor: default; }
.refresh-all-button span { font-variant-numeric: tabular-nums; }
.refresh-all-button.busy { border-color: color-mix(in srgb, var(--app-purple) 35%, var(--app-divider)); color: var(--app-purple); cursor: progress; }
/* a soft light sweeps across while the batch runs */
.refresh-all-button.busy::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--app-purple) 14%, transparent) 50%, transparent 80%);
  transform: translateX(-100%); animation: rab-sweep 1.6s cubic-bezier(.4, 0, .2, 1) infinite;
}
.rab-glyph-enter-active, .rab-glyph-leave-active { transition: opacity 160ms ease, margin 200ms cubic-bezier(.4, 0, .2, 1), width 200ms cubic-bezier(.4, 0, .2, 1); }
.rab-glyph-enter-from, .rab-glyph-leave-to { width: 0 !important; margin-right: -6px; opacity: 0; }
@keyframes rab-sweep { to { transform: translateX(100%); } }
.refresh-all-button.done { border-color: color-mix(in srgb, var(--app-green) 45%, var(--app-divider)); color: var(--app-green); }
.refresh-all-button.failed { border-color: color-mix(in srgb, var(--app-danger) 45%, var(--app-divider)); color: var(--app-danger); }
</style>
