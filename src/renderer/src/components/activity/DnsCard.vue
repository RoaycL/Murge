<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import SurfaceCard from '../SurfaceCard.vue'
import AppIcon from '../AppIcon.vue'
import { useLatencyStore } from '../../stores/latency'
import { useToast } from '../../composables/use-toast'
import { dnsStats } from '../../lib/activity-widgets'

// DNS (Surge 6): mihomo has no resolver statistics API, so the average comes
// from the real lookups the latency probe times once a minute (this session).
// 清空 flushes the kernel's DNS cache, like Surge's button.
const latency = useLatencyStore()
const router = useRouter()
const toast = useToast()
const flushing = ref(false)

const stats = computed(() => dnsStats(latency.dnsHistory))
const bars = computed(() => {
  const samples = latency.dnsHistory
  const max = Math.max(...samples, 1)
  return samples.map((value) => ({ height: Math.max(8, Math.round((value / max) * 100)), slow: value >= 200 }))
})

async function flush(): Promise<void> {
  if (flushing.value) return
  flushing.value = true
  try {
    await window.desktop.mihomo.flushDnsCache()
    latency.clearDnsHistory()
    toast.success(t('widgets.dnsFlushed'))
  } catch {
    toast.error(t('widgets.dnsFlushFailed'))
  } finally {
    flushing.value = false
  }
}
</script>

<template>
  <SurfaceCard class="widget-card widget-half dns-widget">
    <div class="widget-head">
      <button type="button" class="widget-title" @click="router.push('/dns')">DNS<AppIcon name="next" :size="14" /></button>
      <button type="button" class="widget-text-button" :disabled="flushing" @click="flush">{{ t('widgets.clear') }}</button>
    </div>
    <span class="dns-label widget-muted">{{ t('widgets.dnsAverage') }}</span>
    <strong class="dns-average">{{ stats.average ?? '—' }}<i v-if="stats.average != null" class="widget-unit">ms</i></strong>
    <div class="dns-bars" role="img" :aria-label="t('widgets.dnsChart')">
      <i v-for="(bar, index) in bars" :key="index" :class="{ slow: bar.slow }" :style="{ height: `${bar.height}%` }" />
    </div>
    <div class="dns-footer"><span>{{ t('widgets.dnsQueries', [latency.dnsHistory.length]) }}</span><span>{{ t('widgets.max') }} <b>{{ stats.max != null ? `${stats.max} ms` : '—' }}</b></span></div>
  </SurfaceCard>
</template>

<style scoped>
.dns-label { margin-top: 6px; font-size: var(--font-size-xs); }
.dns-average { font-size: var(--font-size-display); line-height: 1.15; font-weight: var(--font-weight-bold); font-variant-numeric: tabular-nums; }
.dns-bars { display: flex; flex: 1 1 auto; align-items: flex-end; gap: 2px; min-height: 18px; margin-top: 6px; }
.dns-bars i { flex: 0 1 4px; min-width: 2px; border-radius: 2px; background: color-mix(in srgb, #f08c2e 75%, white); }
.dns-bars i.slow { background: #f08c2e; }
.dns-footer { display: flex; justify-content: space-between; gap: 4px; margin-top: 4px; color: var(--app-muted); font-size: var(--font-size-2xs); white-space: nowrap; }
.dns-footer b { color: var(--app-text); }
</style>
