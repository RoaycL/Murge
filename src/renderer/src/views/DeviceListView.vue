<script setup lang="ts">
import { computed, ref } from "vue";
import { useConnectionsStore } from "../stores/connections";
import { groupConnectionsByDevice } from "../lib/connection-groups";
import { formatBytes, formatRate, formatWallClock } from "../lib/format";
import AppIcon from "../components/AppIcon.vue";
import DetailDrawer from "../components/DetailDrawer.vue";
import AppSelect from "../components/AppSelect.vue";
import EmptyState from "../components/EmptyState.vue";
import EntityStatsPanel from "../components/EntityStatsPanel.vue";
import type { MihomoConnection } from "@shared/mihomo-api";

const store = useConnectionsStore();
const selectedKey = ref<string | null>(null);
const closing = ref(false);
const sort = ref<"address" | "traffic">("address");
const SORT_OPTIONS = [
  { value: "address", label: "按 IP 排序" },
  { value: "traffic", label: "按流量排序" },
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
    ?? { key: selectedKey.value, label: selectedKey.value, subtitle: "当前没有活动连接", upload: 0, download: 0, connections: [] as MihomoConnection[] };
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
function isPrivateAddress(address: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(address);
}
/**
 * Mihomo reports only the source address and the inbound that accepted the
 * connection, so the kind is inferred from those two facts. There is no MAC,
 * vendor or DHCP lease information in the controller API.
 */
function deviceKind(address: string, connections: readonly MihomoConnection[]): string {
  if (/^(127\.|::1$|::ffff:127\.)/.test(address)) return "本机 · 回环地址";
  if (connections.some((item) => String(item.metadata.type ?? "").toLowerCase() === "tun")) return "本机 · TUN";
  if (isPrivateAddress(address)) return "局域网设备";
  return "其他地址";
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
    { label: "IP 地址", value: group.label },
    { label: "类型", value: connections.length ? deviceKind(group.label, connections) : "—" },
    { label: "入站", value: countBy(connections.map((item) => item.metadata.type)) },
    { label: "进程", value: processes.length ? `${processes.length} 个 · ${processes.slice(0, 3).join(", ")}${processes.length > 3 ? " 等" : ""}` : "—" },
    { label: "最高流量主机名", value: stats.value?.topHost ?? "—" },
    { label: "首次出现", value: stats.value ? formatWallClock(new Date(stats.value.firstSeen)) : "—" },
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
        <h1>已发现设备</h1>
        <small v-if="store.status !== 'live'" aria-live="polite">正在连接</small>
      </div>
      <AppSelect v-model="sort" :options="SORT_OPTIONS" label="设备排序方式" />
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
          }}<small>总计 {{ rowTotal(group) }} · {{ group.connections.length }} 个连接</small></strong
        ><AppIcon name="next" :size="15" />
      </button>
      <EmptyState v-if="!groups.length" icon="devices" title="暂无活动设备" detail="本机或局域网地址产生连接后会显示在这里。" />
    </section>
    <DetailDrawer
      :open="Boolean(selected)"
      :title="selected?.label ?? '设备详情'"
      :subtitle="selected ? (selected.connections.length ? deviceKind(selected.label, selected.connections) : '当前没有活动连接') : ''"
      @close="selectedKey = null"
      ><div v-if="selected" class="entity-detail drawer-detail">
        <EntityStatsPanel :stats="stats" :active-connections="selected.connections.length" :details="details" />
        <h3>活动连接</h3>
        <ul>
          <li v-for="connection in selected.connections" :key="connection.id">
            <span>{{ connection.metadata.process || "未知进程" }} → {{
              connection.metadata.host ||
              connection.metadata.destinationIP ||
              "未知目标"
            }}</span
            ><small>↑ {{ formatBytes(connection.upload) }} ↓ {{ formatBytes(connection.download) }}</small>
          </li>
          <li v-if="!selected.connections.length" class="entity-empty-row">当前没有活动连接</li>
        </ul>
        <button v-if="selected.connections.length" type="button" class="danger-button device-close-all" :disabled="closing" @click="closeSelected">{{ closing ? '正在关闭…' : '关闭该地址的全部连接' }}</button>
      </div></DetailDrawer
    >
  </div>
</template>

<style scoped>
.entity-empty-row{color:var(--app-muted)}
.device-close-all{margin-top:20px}
</style>
