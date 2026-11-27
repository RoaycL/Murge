<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import SurfaceCard from '../SurfaceCard.vue'
import AppIcon from '../AppIcon.vue'
import { usePoliciesStore } from '../../stores/policies'
import { collectNodeLatencies, latencyAxisMax, latencyTone, sortNodeLatencies } from '../../lib/policy-latency'

// 策略延迟 (Surge 6): the latest measured delay of each node on one shared
// axis, fastest first (the arrows flip the order). Delays come from the
// kernel's own test history, so the card fills in as nodes get tested.
const ROWS = 5
const policies = usePoliciesStore()
const router = useRouter()
const order = ref<'asc' | 'desc'>('asc')
let timer: number | null = null

onMounted(() => {
  // Pick up delays tested elsewhere (策略 page, url-test groups) once a minute.
  timer = window.setInterval(() => void policies.load(), 60_000)
})
onUnmounted(() => { if (timer != null) window.clearInterval(timer) })

const nodes = computed(() => sortNodeLatencies(collectNodeLatencies(policies.proxies?.proxies, policies.providerProxies), order.value).slice(0, ROWS))
const axisMax = computed(() => latencyAxisMax(nodes.value))
const ticks = computed(() => [0, 1, 2, 3, 4].map((step) => Math.round((axisMax.value / 4) * step)))
const position = (delay: number): string => `${Math.min(100, (delay / axisMax.value) * 100)}%`
</script>

<template>
  <SurfaceCard class="widget-card widget-square policy-latency-widget">
    <div class="widget-head">
      <button type="button" class="widget-title" @click="router.push('/policies')">{{ t('widgets.policyLatency') }}<AppIcon name="next" :size="14" /></button>
      <button type="button" class="widget-icon-button sort-button" :aria-label="order === 'asc' ? t('widgets.slowestFirst') : t('widgets.fastestFirst')" :title="order === 'asc' ? t('widgets.slowestFirst') : t('widgets.fastestFirst')" @click="order = order === 'asc' ? 'desc' : 'asc'"><AppIcon name="move-up" :size="14" :stroke-width="2.2" /><AppIcon name="move-down" :size="14" :stroke-width="2.2" /></button>
    </div>
    <template v-if="nodes.length">
      <div class="latency-rows">
        <div v-for="node in nodes" :key="node.name" class="latency-row" :class="`tone-${latencyTone(node.delay)}`">
          <span class="latency-name" :title="node.name">{{ node.name }}</span>
          <div class="latency-track"><i class="fill" :style="{ width: position(node.delay) }" /><i v-for="tick in 3" :key="tick" class="tick" :style="{ left: `${tick * 25}%` }" /><b :style="{ left: position(node.delay) }" /></div>
          <strong>{{ node.delay }} ms</strong>
        </div>
      </div>
      <div class="latency-axis"><span v-for="(tick, index) in ticks" :key="index" :style="{ left: `${index * 25}%` }">{{ tick }}</span></div>
    </template>
    <p v-else class="widget-empty">{{ t('widgets.policyLatencyEmpty') }}</p>
  </SurfaceCard>
</template>

<style scoped>
.sort-button { width: auto; padding: 0 4px; border-radius: 12px; }
.sort-button svg + svg { margin-left: -5px; }
.latency-rows { display: flex; flex: 1 1 auto; flex-direction: column; justify-content: space-around; margin-top: 4px; }
.latency-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name name" "track value"; column-gap: 12px; align-items: center; }
.latency-name { grid-area: name; overflow: hidden; font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.latency-row strong { grid-area: value; min-width: 52px; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); font-variant-numeric: tabular-nums; text-align: right; }
.latency-track { grid-area: track; position: relative; height: 12px; margin-right: 52px; }
.latency-track::before { content: ""; position: absolute; top: 5px; left: 0; right: 0; height: 2px; border-radius: 1px; background: var(--app-fill); }
.latency-track .fill { position: absolute; top: 5px; left: 0; height: 2px; border-radius: 1px; background: color-mix(in srgb, var(--tone) 45%, transparent); }
.latency-track .tick { position: absolute; top: 3px; width: 1px; height: 6px; background: var(--app-divider); }
.latency-track b { position: absolute; top: 1px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 22%, transparent); }
.tone-good { --tone: var(--app-green); }
.tone-fair { --tone: #f08c2e; }
.tone-poor { --tone: var(--app-danger); }
.latency-axis { position: relative; height: 14px; margin: 4px 64px 0 0; color: var(--app-faint); font-size: var(--font-size-2xs); }
.latency-axis span { position: absolute; transform: translateX(-50%); }
.latency-axis span:first-child { transform: none; }
.latency-axis span:last-child { transform: translateX(-100%); }
</style>
