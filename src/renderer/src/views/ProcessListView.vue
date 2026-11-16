<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, ref } from "vue";
import { useConnectionsStore } from "../stores/connections";
import { useOverridesStore } from "../stores/overrides";
import { usePoliciesStore } from "../stores/policies";
import { groupConnectionsByProcess } from "../lib/connection-groups";
import { formatBytes, formatRate, formatWallClock } from "../lib/format";
import AppIcon from "../components/AppIcon.vue";
import ProcessIcon from "../components/ProcessIcon.vue";
import DetailDrawer from "../components/DetailDrawer.vue";
import AppSelect from "../components/AppSelect.vue";
import EmptyState from "../components/EmptyState.vue";
import EntityStatsPanel from "../components/EntityStatsPanel.vue";
import { formatConnectionChain } from "@shared/connection-chain";
import { buildProcessRuleOverride, type ProcessRuleMatch } from "@shared/process-rule";

const store = useConnectionsStore();
const overrides = useOverridesStore();
const policies = usePoliciesStore();
const selectedKey = ref<string | null>(null);
const sort = ref<"traffic" | "name">("traffic");
const match = ref<ProcessRuleMatch>("path");
const target = ref("DIRECT");
const savingRule = ref(false);
const ruleError = ref("");
const lastCreated = ref<{ id: string; rule: string } | null>(null);
const matchOptions = computed(() => [
  { value: "path", label: t('processes.matchPath'), disabled: !processPath.value },
  { value: "name", label: t('processes.matchName') },
]);
const SORT_OPTIONS = [
  { value: "traffic", label: t('common.sortTraffic') },
  { value: "name", label: t('processes.sortName') },
] as const;
const groups = computed(() => {
  const rows = groupConnectionsByProcess(store.snapshot?.connections ?? []);
  return sort.value === "name"
    ? [...rows].sort((a, b) => a.label.localeCompare(b.label))
    : rows;
});
// Remember who was opened so the drawer (and its history) stays up after the
// process closes its last connection.
const selectedMeta = ref<{ label: string; subtitle: string; path: string } | null>(null);
const selected = computed(() => {
  if (!selectedKey.value) return null;
  const live = groups.value.find((group) => group.key === selectedKey.value);
  if (live) return live;
  const meta = selectedMeta.value;
  return meta ? { key: selectedKey.value, label: meta.label, subtitle: meta.subtitle, upload: 0, download: 0, connections: [] } : null;
});
const processPath = computed(() => selected.value?.connections[0]?.metadata.processPath?.trim() ?? selectedMeta.value?.path ?? "");
const stats = computed(() => (selectedKey.value ? store.entityStats("process", selectedKey.value) : null));
const totals = computed(() => store.entityTotals("process"));
function rowRate(key: string): string {
  const rate = totals.value.get(key)?.rate;
  const text = formatRate((rate?.up ?? 0) + (rate?.down ?? 0));
  return `${text.value} ${text.unit}`;
}
function rowTotal(group: { key: string; upload: number; download: number }): string {
  const total = totals.value.get(group.key);
  return formatBytes(total ? total.up + total.down : group.upload + group.download);
}
function countBy(values: Array<string | undefined>): string {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(" · ") || "—";
}
const details = computed(() => {
  const group = selected.value;
  if (!group) return [];
  const connections = group.connections;
  return [
    { label: t('processes.processName'), value: group.label },
    { label: t('groupWizard.path'), value: processPath.value || "—" },
    { label: t('activity.network'), value: countBy(connections.map((item) => item.metadata.network?.toUpperCase())) },
    { label: t('devices.inbound'), value: countBy(connections.map((item) => item.metadata.type)) },
    { label: t('processes.sourceDevice'), value: [...new Set(connections.map((item) => item.metadata.sourceIP).filter(Boolean))].join(", ") || "—" },
    { label: t('devices.topHost'), value: stats.value?.topHost ?? "—" },
    { label: t('devices.firstSeen'), value: stats.value ? formatWallClock(new Date(stats.value.firstSeen)) : "—" },
  ];
});
const targetOptions = computed(() => [
  { value: "DIRECT", label: t('connRule.directOption') },
  ...policies.groups.filter((group) => group.name !== "DIRECT" && !/[\r\n,]/.test(group.name)).map((group) => ({ value: group.name, label: group.name })),
]);
const draft = computed(() => {
  if (!selected.value || selected.value.label === t('common.unknownProcess')) return null;
  try {
    return buildProcessRuleOverride({
      processName: selected.value.label,
      processPath: processPath.value,
      match: match.value,
      target: target.value,
    });
  } catch { return null; }
});

function selectProcess(key: string): void {
  const group = groups.value.find((item) => item.key === key);
  selectedMeta.value = group ? { label: group.label, subtitle: group.subtitle, path: group.connections[0]?.metadata.processPath?.trim() ?? "" } : null;
  selectedKey.value = key;
  match.value = processPath.value && !/[\r\n,]/.test(processPath.value) ? "path" : "name";
  target.value = "DIRECT";
  ruleError.value = "";
}

async function saveRule(): Promise<void> {
  if (!draft.value || savingRule.value || !targetOptions.value.some((option) => option.value === target.value)) return;
  savingRule.value = true;
  ruleError.value = "";
  try {
    await overrides.refresh();
    if (overrides.lastError) throw new Error(overrides.lastError);
    const before = new Set(overrides.items.map((item) => item.id));
    const saved = await overrides.create(draft.value);
    if (!saved) throw new Error(overrides.lastError ?? t('common.saveFailed'));
    const created = overrides.items.find((item) => !before.has(item.id));
    if (created) lastCreated.value = { id: created.id, rule: draft.value.rule };
  } catch (error) {
    ruleError.value = error instanceof Error ? error.message : t('common.saveFailed');
  } finally { savingRule.value = false; }
}

async function undoRule(): Promise<void> {
  if (!lastCreated.value || savingRule.value) return;
  savingRule.value = true;
  const removed = await overrides.remove(lastCreated.value.id);
  if (removed) lastCreated.value = null;
  else ruleError.value = overrides.lastError ?? t('connRule.undoFailed');
  savingRule.value = false;
}

onMounted(() => {
  void policies.load();
  void overrides.refresh();
});
</script>
<template>
  <div class="page-shell list-detail-page">
    <header class="page-toolbar">
      <div>
        <h1>{{ t('nav.processes') }}</h1>
        <small aria-live="polite">{{
          store.status === "live"
            ? t('processes.summaryTitle', [groups.length])
            : t('processes.connectedNow')
        }}</small>
      </div>
      <AppSelect v-model="sort" :options="SORT_OPTIONS" :label="t('processes.sortLabel')" />
    </header>
    <div v-if="lastCreated" class="process-rule-notice surface-card" role="status">
      <span><strong>{{ t('processes.ruleSaved') }}</strong><small>{{ t('processes.ruleSavedHint', [lastCreated.rule]) }}</small></span>
      <button type="button" :disabled="savingRule" @click="undoRule">{{ t('common.undo') }}</button>
    </div>
    <p v-if="ruleError" class="inline-error" role="alert">{{ ruleError }}</p>
    <section class="surface-card entity-list full-width-list">
      <button
        v-for="group in groups"
        :key="group.key"
        type="button"
        class="entity-row wide"
        :class="{ selected: selectedKey === group.key }"
        :aria-pressed="selectedKey === group.key"
        @click="selectProcess(group.key)"
      >
        <ProcessIcon class="process-list-icon" :path="group.connections[0]?.metadata.processPath" :name="group.label" :size="16" />
        <span
          >{{ group.label }}<small>{{ group.subtitle }}</small></span
        ><strong
          >{{ rowRate(group.key)
          }}<small>{{ t('common.totalConnections', [rowTotal(group), group.connections.length]) }}</small></strong
        ><AppIcon name="next" :size="15" />
      </button>
      <EmptyState v-if="!groups.length" icon="processes" :title="t('processes.emptyTitle')" :detail="t('processes.emptyDetail')" />
    </section>
    <DetailDrawer
      :open="Boolean(selected)"
      :title="selected?.label ?? t('processes.detailTitle')"
      :subtitle="selected?.subtitle"
      @close="selectedKey = null"
      ><div v-if="selected" class="entity-detail drawer-detail">
        <EntityStatsPanel :stats="stats" :active-connections="selected.connections.length" :details="details" />
        <h3>{{ t('common.activeConnections') }}</h3>
        <ul>
          <li v-for="connection in selected.connections" :key="connection.id">
            <span>{{
              connection.metadata.host ||
              connection.metadata.destinationIP ||
              t('diagnosis.unknownTarget')
            }}</span
            ><small>{{ formatConnectionChain(connection.chains) }} · ↑ {{ formatBytes(connection.upload) }} ↓ {{ formatBytes(connection.download) }}</small>
          </li>
          <li v-if="!selected.connections.length" class="entity-empty-row">{{ t('devices.noActive') }}</li>
        </ul>
        <section class="process-rule-editor" :aria-label="t('processes.createRuleLabel')">
          <h3>{{ t('processes.createRule') }}</h3>
          <p>{{ t('processes.createRuleHint') }}</p>
          <label>{{ t('processes.matchBy') }}<AppSelect v-model="match" :options="matchOptions" :label="t('processes.matchByLabel')" /></label>
          <label>{{ t('connRule.outbound') }}<AppSelect v-model="target" :options="targetOptions" :label="t('processes.outboundLabel')" /></label>
          <div class="process-rule-preview"><span>{{ t('connRule.preview') }}</span><code>{{ draft?.rule ?? t('processes.insufficient') }}</code></div>
          <button type="button" class="process-rule-save" :disabled="!draft || savingRule || !targetOptions.some((option) => option.value === target)" @click="saveRule">{{ savingRule ? t('common.saving') : t('connRule.saveRule') }}</button>
        </section>
      </div></DetailDrawer
    >
  </div>
</template>

<style scoped>
.process-list-icon{width:29px;height:29px;border-radius:var(--radius-control);background:var(--app-fill)}
.process-rule-notice{display:flex;align-items:center;justify-content:space-between;gap:var(--space-7);padding:12px 16px;margin:12px 0}
.process-rule-notice span{display:flex;flex-direction:column;gap:var(--space-1);min-width:0}
.process-rule-notice small{color:var(--app-muted);overflow-wrap:anywhere}
.process-rule-notice button{border:1px solid var(--app-divider);background:transparent;color:var(--app-text);border-radius:var(--radius-control);padding:7px 13px;cursor:pointer}
.entity-empty-row{color:var(--app-muted)}
.process-rule-editor{display:grid;gap:var(--space-5);margin:24px 0 4px;padding:17px;border:1px solid var(--app-divider);border-radius:var(--radius-card);background:color-mix(in srgb,var(--app-surface) 78%,var(--app-bg))}
.process-rule-editor h3{margin:0}
.process-rule-editor p{margin:0;color:var(--app-muted);font-size:var(--font-size-xs);line-height:1.5}
.process-rule-editor label{display:flex;align-items:center;justify-content:space-between;gap:var(--space-5);font-size:var(--font-size-sm)}
.process-rule-preview{display:grid;gap:var(--space-2);padding:11px;border-radius:var(--radius-control);background:color-mix(in srgb,var(--app-bg) 78%,var(--app-surface));min-width:0}
.process-rule-preview span{font-size:var(--font-size-xs);color:var(--app-muted)}
.process-rule-preview code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--font-size-xs)}
.process-rule-save{justify-self:end;border:0;border-radius:var(--radius-control);background:var(--app-accent);color:var(--app-on-accent);padding:8px 14px;cursor:pointer}
.process-rule-save:disabled{opacity:.5;cursor:not-allowed}
</style>
