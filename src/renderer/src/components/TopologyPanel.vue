<script setup lang="ts">
import { computed } from 'vue'
import SurfaceCard from './SurfaceCard.vue'
import { useConnectionsStore } from '../stores/connections'
import { buildTopology, topologyHopLabel, topologyIncompleteText } from '@shared/topology'
import { formatBytes } from '../lib/format'

const connections = useConnectionsStore()

/** Derived read-only topology from the live connection stream. */
const summary = computed(() => buildTopology(connections.snapshot?.connections ?? []))

const totals = computed(() => {
  const value = summary.value
  const parts = [`${value.proxiedCount} 代理`, `${value.directCount} 直连`]
  if (value.unknownChainCount > 0) parts.push(`${value.unknownChainCount} 未知`)
  return parts.join(' · ')
})

const incompleteNote = computed(() => topologyIncompleteText(summary.value))

function pathRuleLabel(rule: string | null, payload: string | null): string | null {
  if (!rule) return null
  return payload ? `${rule} ${payload}` : rule
}

function hopClass(name: string): string {
  return name === 'DIRECT' ? 'topo-hop direct' : 'topo-hop'
}
</script>

<template>
  <SurfaceCard class="topology-card">
    <div class="card-title-row">
      <span class="metric-label">路由拓扑<em class="status">{{ totals }}</em></span>
      <span class="topology-total">{{ summary.totalConnections }} 条连接</span>
    </div>

    <p v-if="incompleteNote" class="inline-note" role="note">{{ incompleteNote }}</p>
    <p v-if="!summary.totalConnections" class="topology-empty">暂无连接数据，流量产生后这里会显示路由拓扑。</p>

    <template v-else>
      <div class="topology-section">
        <span class="topology-heading">路由路径</span>
        <div v-if="summary.paths.length" class="path-list">
          <div v-for="path in summary.paths" :key="path.id" class="path-row">
            <div class="path-meta">
              <span v-if="pathRuleLabel(path.rule, path.rulePayload)" class="rule-chip">{{ pathRuleLabel(path.rule, path.rulePayload) }}</span>
              <span class="path-bytes">{{ formatBytes(path.bytes) }}</span>
              <span class="path-count">{{ path.connections }} 条</span>
            </div>
            <div class="path-hops">
              <template v-for="(hop, index) in path.hops" :key="`${path.id}-${index}`">
                <span :class="hopClass(hop)">{{ hop }}</span>
                <i v-if="index < path.hops.length - 1" class="path-arrow" aria-hidden="true">→</i>
              </template>
            </div>
          </div>
        </div>
        <p v-else class="topology-empty">当前连接未提供可用路由链。</p>
      </div>

      <div class="topology-section">
        <span class="topology-heading">跳点分布<span class="heading-hint">（按流量）</span></span>
        <div v-if="summary.nodes.length" class="node-list">
          <div v-for="node in summary.nodes" :key="node.name" class="node-row">
            <span class="node-name">{{ topologyHopLabel(node) }}</span>
            <div class="node-bar"><i :style="{ width: `${summary.maxBytes ? (node.download + node.upload) / summary.maxBytes * 100 : 0}%` }" /></div>
            <strong>{{ formatBytes(node.download + node.upload) }}</strong>
          </div>
        </div>
        <p v-else class="topology-empty">当前连接未提供可用跳点。</p>
      </div>
    </template>
  </SurfaceCard>
</template>

<style scoped>
.topology-card { min-width: 0; }
.card-title-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.status { font-style: normal; color: var(--app-muted); font-size: var(--font-size-2xs); margin-left: 6px; }
.topology-total { color: var(--app-muted); font-size: var(--font-size-xs); }
.topology-empty { margin: 14px 0; color: var(--app-muted); font-size: var(--font-size-xs); }
.inline-note { margin: 12px 0 0; color: var(--app-warning); font-size: var(--font-size-xs); }
.topology-section { margin-top: 14px; }
.topology-heading { display: block; color: var(--app-muted); font-size: var(--font-size-2xs); letter-spacing: 0.06em; }
.heading-hint { color: var(--app-faint); }
.path-list { display: grid; gap: var(--space-3); margin-top: 8px; }
.path-row { display: grid; gap: var(--space-2); padding: 10px 12px; border: 1px solid var(--app-surface-border); border-radius: var(--radius-control); background: var(--app-surface); }
.path-meta { display: flex; align-items: center; gap: var(--space-4); }
.rule-chip { padding: 1px 8px; border-radius: var(--radius-sm); background: rgba(21, 135, 248, 0.12); color: var(--app-blue); font-size: var(--font-size-2xs); }
.path-bytes { font-size: var(--font-size-sm); font-weight: var(--font-weight-bold); margin-left: auto; }
.path-count { color: var(--app-muted); font-size: var(--font-size-2xs); }
.path-hops { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); }
.topo-hop { padding: 2px 8px; border-radius: var(--radius-sm); border: 1px solid var(--app-divider); font-size: var(--font-size-xs); }
.topo-hop.direct { color: var(--app-muted); }
.path-arrow { color: var(--app-faint); font-size: var(--font-size-xs); font-style: normal; }
.node-list { display: grid; gap: var(--space-2); margin-top: 8px; }
.node-row { display: grid; grid-template-columns: 120px 1fr auto; align-items: center; gap: var(--space-4); }
.node-name { font-size: var(--font-size-xs); }
.node-bar { height: 7px; border-radius: var(--radius-xs); background: var(--app-fill); overflow: hidden; }
.node-bar i { display: block; height: 100%; background: var(--app-blue); border-radius: var(--radius-xs); }
.node-row strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); font-variant-numeric: tabular-nums; }
</style>
