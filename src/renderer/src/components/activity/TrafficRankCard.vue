<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import SurfaceCard from '../SurfaceCard.vue'
import AppIcon from '../AppIcon.vue'
import CachedRemoteIcon from '../CachedRemoteIcon.vue'
import { useConnectionsStore } from '../../stores/connections'
import { usePoliciesStore } from '../../stores/policies'
import { formatBytes } from '../../lib/format'

// 流量排行 (Surge 6): the top domains or policies by traffic since the app
// started, closed connections included.
const ROWS = 5
const connections = useConnectionsStore()
const policies = usePoliciesStore()
const router = useRouter()
const dimension = ref<'host' | 'policy'>('host')

const rows = computed(() => (dimension.value === 'host' ? connections.allHosts : connections.allPolicies).slice(0, ROWS))
const count = computed(() => (dimension.value === 'host' ? connections.allHosts.length : connections.allPolicies.length))
const policyIcons = computed<Record<string, string>>(() => Object.fromEntries(
  policies.groups.flatMap((group) => group.icon ? [[group.name, group.icon] as const] : [])
))

/** A stable soft colour per name for the letter badge. */
function badgeHue(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}
/** The registrable part's first letter: `iosapps.itunes.apple.com` → A. */
function badgeLetter(name: string): string {
  const labels = name.split('.').filter(Boolean)
  const core = labels.length >= 2 && !/^\d+$/.test(labels[labels.length - 1]) ? labels[labels.length - 2] : name
  return (core[0] ?? '?').toUpperCase()
}
</script>

<template>
  <SurfaceCard class="widget-card widget-square ranking-widget">
    <div class="widget-head">
      <button type="button" class="widget-title" @click="router.push('/connections')">{{ t('widgets.ranking') }}<AppIcon name="next" :size="14" /></button>
      <div class="segmented widget-segmented" role="group" :aria-label="t('widgets.rankingBy')">
        <button type="button" :class="{ selected: dimension === 'host' }" :aria-pressed="dimension === 'host'" @click="dimension = 'host'">{{ t('sniffer.domains') }}</button>
        <button type="button" :class="{ selected: dimension === 'policy' }" :aria-pressed="dimension === 'policy'" @click="dimension = 'policy'">{{ t('common.policy') }}</button>
      </div>
    </div>
    <div v-if="rows.length" class="ranking-rows">
      <div v-for="row in rows" :key="row.name" class="ranking-row">
        <span class="ranking-badge" :style="{ '--hue': badgeHue(row.name) }"><CachedRemoteIcon v-if="dimension === 'policy' && policyIcons[row.name]" :src="policyIcons[row.name]" :cache-key="`policy:${row.name}`" /><template v-else>{{ badgeLetter(row.name) }}</template></span>
        <div class="ranking-main">
          <div class="ranking-line"><span :title="row.name">{{ row.name }}</span><strong>{{ formatBytes(row.bytes) }}</strong></div>
          <i class="ranking-bar"><b :style="{ width: `${row.width}%` }" /></i>
        </div>
      </div>
    </div>
    <p v-else class="widget-empty">{{ t('widgets.rankingEmpty') }}</p>
    <div class="ranking-footer"><span>{{ t('widgets.sinceStart') }}</span><span><b>{{ count }}</b> {{ dimension === 'host' ? t('widgets.domainsUnit') : t('widgets.policiesUnit') }}</span></div>
  </SurfaceCard>
</template>

<style scoped>
.ranking-rows { display: flex; flex: 1 1 auto; flex-direction: column; justify-content: space-around; min-height: 0; margin-top: 6px; }
.ranking-row { display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: center; gap: 10px; }
.ranking-badge { display: grid; place-items: center; width: 26px; height: 26px; overflow: hidden; border: 1px solid var(--app-divider); border-radius: 7px; background: hsl(var(--hue) 70% 94%); color: hsl(var(--hue) 55% 42%); font-size: var(--font-size-xs); font-weight: var(--font-weight-bold); }
.ranking-badge :deep(img) { width: 100%; height: 100%; object-fit: contain; }
.ranking-line { display: flex; justify-content: space-between; gap: 8px; font-size: var(--font-size-sm); }
.ranking-line span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ranking-line strong { flex: none; font-weight: var(--font-weight-semibold); font-variant-numeric: tabular-nums; }
.ranking-bar { display: block; height: 3px; margin-top: 4px; border-radius: 2px; background: var(--app-fill); overflow: hidden; }
.ranking-bar b { display: block; height: 100%; border-radius: 2px; background: var(--app-purple); }
.ranking-footer { display: flex; justify-content: space-between; margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--app-divider); color: var(--app-muted); font-size: var(--font-size-xs); }
.ranking-footer b { color: var(--app-text); }
:root[data-theme="dark"] .ranking-badge { background: hsl(var(--hue) 35% 22%); color: hsl(var(--hue) 70% 75%); }
</style>
