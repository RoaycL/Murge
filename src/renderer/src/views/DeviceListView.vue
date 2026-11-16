<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, ref } from "vue";
import { useConnectionsStore } from "../stores/connections";
import { groupConnectionsByDevice } from "../lib/connection-groups";
import { formatBytes, formatRate, formatWallClock } from "../lib/format";
import AppIcon from "../components/AppIcon.vue";
import DetailDrawer from "../components/DetailDrawer.vue";
import AppSelect from "../components/AppSelect.vue";
import EmptyState from "../components/EmptyState.vue";
import EntityStatsPanel from "../components/EntityStatsPanel.vue";
import type { MihomoConnection } from "@shared/mihomo-api";
import { describeDevice, isThisHost } from "@shared/lan";
import { useLanStore } from "../stores/lan";
import { useCoreSettingsStore } from "../stores/core-settings";
import { useRouter } from "vue-router";

const store = useConnectionsStore();
const lan = useLanStore();
const core = useCoreSettingsStore();
const router = useRouter();
onMounted(() => {
  void lan.refresh();
  void core.refresh();
});
/** Other LAN devices only reach mihomo through allow-lan (proxy) or TUN (gateway). */
const onlyThisHost = computed(() => groups.value.every((group) => isThisHost(group.label, lan.addresses)));
const selectedKey = ref<string | null>(null);
const closing = ref(false);
const sort = ref<"address" | "traffic">("address");
const SORT_OPTIONS = [
  { value: "address", label: t('devices.sortIp') },
  { value: "traffic", label: t('devices.sortTraffic') },
] as const;
const groups = computed(() => {
  const rows = groupConnectionsByDevice(store.snapshot?.connections ?? []);
  return sort.value === "address"
    ? [...rows].sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true }),
      )
    : rows;
});
// Keep the drawer open (with its history) after the device's last connection closes.
const selected = computed(() => {
  if (!selectedKey.value) return null;
  return groups.value.find((group) => group.key === selectedKey.value)
    ?? { key: selectedKey.value, label: selectedKey.value, subtitle: t('devices.noActive'), upload: 0, download: 0, connections: [] as MihomoConnection[] };
});
const stats = computed(() => (selectedKey.value ? store.entityStats("device", selectedKey.value) : null));
const totals = computed(() => store.entityTotals("device"));
function rowRate(key: string): string {
  const rate = totals.value.get(key)?.rate;
  const text = formatRate((rate?.up ?? 0) + (rate?.down ?? 0));
  return `${text.value} ${text.unit}`;
}
function rowTotal(group: { key: string; upload: number; download: number }): string {
  const total = totals.value.get(group.key);
  return formatBytes(total ? total.up + total.down : group.upload + group.download);
}
/**
 * Mihomo reports only the source address and the inbound that accepted the
 * connection, so the kind is inferred from those two facts plus this PC's own
 * addresses. There is no MAC, vendor or DHCP lease information in the
 * controller API.
 */
function deviceKind(address: string, connections: readonly MihomoConnection[]): string {
  return describeDevice(address, connections.map((item) => String(item.metadata.type ?? "")), lan.addresses);
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
  const processes = [...new Set(connections.map((item) => item.metadata.process?.trim()).filter(Boolean))];
  return [
    { label: t('devices.ipAddress'), value: group.label },
    { label: t('common.type'), value: connections.length ? deviceKind(group.label, connections) : "—" },
    { label: t('devices.inbound'), value: countBy(connections.map((item) => item.metadata.type)) },
    { label: t('common.process'), value: processes.length ? t('devices.processSummary', [processes.length, processes.slice(0, 3).join(", "), processes.length > 3 ? t('devices.andMore') : ""]) : "—" },
    { label: t('devices.topHost'), value: stats.value?.topHost ?? "—" },
    { label: t('devices.firstSeen'), value: stats.value ? formatWallClock(new Date(stats.value.firstSeen)) : "—" },
  ];
});
async function closeSelected(): Promise<void> {
  if (!selected.value || closing.value) return
  closing.value = true
  try { await store.closeMany(selected.value.connections.map((item) => item.id)) }
  finally { closing.value = false }
}
</script>
<template>
  <div class="page-shell list-detail-page">
    <header class="page-toolbar">
      <div>
        <h1>{{ t('devices.discovered') }}</h1>
        <small v-if="store.status !== 'live'" aria-live="polite">{{ t('devices.connecting') }}</small>
      </div>
      <AppSelect v-model="sort" :options="SORT_OPTIONS" :label="t('devices.sortLabel')" />
    </header>
    <section class="surface-card entity-list full-width-list">
      <button
        v-for="group in groups"
        :key="group.key"
        type="button"
        class="entity-row wide"
        :class="{ selected: selectedKey === group.key }"
        :aria-pressed="selectedKey === group.key"
        @click="selectedKey = group.key"
      >
        <i><AppIcon name="devices" :size="16" /></i
        ><span
          >{{ group.label }}<small>{{ deviceKind(group.label, group.connections) }}</small></span
        ><strong
          >{{ rowRate(group.key)
          }}<small>{{ t('devices.summary', [rowTotal(group), group.connections.length]) }}</small></strong
        ><AppIcon name="next" :size="15" />
      </button>
      <EmptyState v-if="!groups.length" icon="devices" :title="t('devices.emptyTitle')" :detail="t('devices.emptyDetail')" />
      <p v-if="onlyThisHost && !core.settings.allowLan" class="device-lan-hint">
        {{ t('devices.lanHint') }}
        <button type="button" class="link-button" @click="router.push('/overview')">{{ t('devices.goOverview') }}</button>
      </p>
    </section>
    <DetailDrawer
      :open="Boolean(selected)"
      :title="selected?.label ?? t('devices.detailTitle')"
      :subtitle="selected ? (selected.connections.length ? deviceKind(selected.label, selected.connections) : t('devices.noActive')) : ''"
      @close="selectedKey = null"
      ><div v-if="selected" class="entity-detail drawer-detail">
        <EntityStatsPanel :stats="stats" :active-connections="selected.connections.length" :details="details" />
        <h3>{{ t('common.activeConnections') }}</h3>
        <ul>
          <li v-for="connection in selected.connections" :key="connection.id">
            <span>{{ connection.metadata.process || t('common.unknownProcess') }} → {{
              connection.metadata.host ||
              connection.metadata.destinationIP ||
              t('diagnosis.unknownTarget')
            }}</span
            ><small>↑ {{ formatBytes(connection.upload) }} ↓ {{ formatBytes(connection.download) }}</small>
          </li>
          <li v-if="!selected.connections.length" class="entity-empty-row">{{ t('devices.noActive') }}</li>
        </ul>
        <button v-if="selected.connections.length" type="button" class="danger-button device-close-all" :disabled="closing" @click="closeSelected">{{ closing ? t('devices.closing') : t('devices.closeAll') }}</button>
      </div></DetailDrawer
    >
  </div>
</template>

<style scoped>
.entity-empty-row{color:var(--app-muted)}
.device-close-all{margin-top:20px}
.device-lan-hint{margin:0;padding:14px 18px;border-top:1px solid var(--app-separator, var(--app-fill));color:var(--app-muted);font-size:var(--font-size-sm);line-height:1.55}
.link-button{padding:0;border:0;background:none;color:var(--app-blue);font:inherit;cursor:pointer}
.link-button:hover{text-decoration:underline}
</style>
