<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'

/**
 * Purpose-built refresh glyph with four states instead of a plain spin:
 * - idle: a single-arrow refresh mark (matches AppIcon 'refresh').
 * - busy: the arrows twist out and a comet arc orbits a faint track while its
 *   length breathes, so a long pull still reads as "working", not "stuck".
 * - done: a check draws itself in green, then settles back to idle.
 * - failed: a short red shake with an exclamation, then back to idle.
 */
const props = withDefaults(defineProps<{ busy: boolean; failed?: boolean; size?: number }>(), { failed: false, size: 16 })

type State = 'idle' | 'busy' | 'done' | 'failed'
const state = ref<State>(props.busy ? 'busy' : 'idle')
let settle: number | null = null

function clearSettle(): void {
  if (settle != null) window.clearTimeout(settle)
  settle = null
}

watch(() => props.busy, (busy, was) => {
  clearSettle()
  if (busy) { state.value = 'busy'; return }
  if (!was) return
  state.value = props.failed ? 'failed' : 'done'
  settle = window.setTimeout(() => { state.value = 'idle'; settle = null }, props.failed ? 1600 : 1300)
})
onUnmounted(clearSettle)

defineExpose({ state })
</script>

<template>
  <svg
    class="refresh-indicator"
    :class="`is-${state}`"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <g class="ri-arrows">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </g>
    <g class="ri-orbit">
      <circle class="ri-track" cx="12" cy="12" r="8.5" />
      <circle class="ri-comet" cx="12" cy="12" r="8.5" pathLength="100" />
    </g>
    <path class="ri-check" d="M6.5 12.5l3.6 3.6L17.5 8.5" pathLength="1" />
    <g class="ri-alert">
      <path d="M12 6.5v7" />
      <path d="M12 17.5h.01" />
    </g>
  </svg>
</template>

<style scoped>
.refresh-indicator { display: block; flex: none; overflow: visible; }
.refresh-indicator > * { transform-box: view-box; transform-origin: 12px 12px; }

/* idle arrows: twist + shrink away when work starts, spring back after. */
.ri-arrows { transition: opacity 180ms ease, transform 320ms cubic-bezier(.34, 1.56, .64, 1); }
.is-busy .ri-arrows, .is-done .ri-arrows, .is-failed .ri-arrows { opacity: 0; transform: rotate(150deg) scale(.4); transition-timing-function: ease, cubic-bezier(.4, 0, .2, 1); }

/* busy orbit */
.ri-orbit { opacity: 0; transform: scale(.6); transition: opacity 160ms ease, transform 260ms cubic-bezier(.34, 1.56, .64, 1); }
.ri-track { stroke-opacity: .16; }
.ri-comet { stroke-dasharray: 10 90; stroke-width: 2.4; }
.is-busy .ri-orbit { opacity: 1; transform: scale(1); color: var(--app-purple); animation: ri-orbit 1.15s linear infinite; }
.is-busy .ri-comet { animation: ri-breathe 1.5s cubic-bezier(.45, 0, .55, 1) infinite; }
@keyframes ri-orbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes ri-breathe {
  0% { stroke-dasharray: 8 92; stroke-dashoffset: 0; }
  50% { stroke-dasharray: 58 42; stroke-dashoffset: -22; }
  100% { stroke-dasharray: 8 92; stroke-dashoffset: -100; }
}

/* done: a check that draws itself */
.ri-check { opacity: 0; stroke-dasharray: 1; stroke-dashoffset: 1; color: var(--app-green); stroke-width: 2.4; }
.is-done .ri-check { opacity: 1; animation: ri-draw 340ms cubic-bezier(.65, 0, .35, 1) 80ms forwards, ri-pop 420ms cubic-bezier(.34, 1.56, .64, 1); }
@keyframes ri-draw { to { stroke-dashoffset: 0; } }
@keyframes ri-pop { 0% { transform: scale(.6); } 100% { transform: scale(1); } }

/* failed: exclamation with a short shake */
.ri-alert { opacity: 0; color: var(--app-danger); stroke-width: 2.4; }
.is-failed .ri-alert { opacity: 1; animation: ri-shake 420ms cubic-bezier(.36, .07, .19, .97); }
@keyframes ri-shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-2px); }
  40%, 80% { transform: translateX(2px); }
}

/* 减少动态效果: keep a static, still-readable busy arc instead of a frozen first frame. */
:global(:root[data-reduce-motion="true"]) .is-busy .ri-comet { stroke-dasharray: 40 60; }
</style>
