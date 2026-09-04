<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useConnectionsStore } from "../stores/connections";
import { groupConnectionsByDevice } from "../lib/connection-groups";
import { formatBytes } from "../lib/format";
import AppIcon from "../components/AppIcon.vue";
import DetailDrawer from "../components/DetailDrawer.vue";
import AppSelect from "../components/AppSelect.vue";
import EmptyState from "../components/EmptyState.vue";

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
const selected = computed(
  () => groups.value.find((group) => group.key === selectedKey.value) ?? null,
);
onMounted(store.connect);
onUnmounted(store.disconnect);
async function closeSelected(): Promise<void> {
  if (!selected.value || closing.value) return
  closing.value = true
  try { await store.closeMany(selected.value.connections.map((item) => item.id)); selectedKey.value = null }
  finally { closing.value = false }
}
</script>
<template>
  <div class="page-shell list-detail-page">
    <header class="page-toolbar">
      <div>
        <h1>已发现设备</h1>
        <small aria-live="polite">{{
          store.status === "live"
            ? `${groups.length} 个活动来源地址 · 根据 mihomo 连接数据汇总`
            : "正在连接"
        }}</small>
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
          >{{ group.label }}<small>{{ group.subtitle }}</small></span
        ><strong
          >{{ formatBytes(group.upload + group.download)
          }}<small>{{ group.connections.length }} 个连接</small></strong
        ><AppIcon name="next" :size="15" />
      </button>
      <EmptyState v-if="!groups.length" icon="devices" title="暂无活动设备" detail="本机或局域网地址产生连接后会显示；mihomo 不提供 DHCP、MAC 或设备名称。" />
    </section>
    <DetailDrawer
      :open="Boolean(selected)"
      :title="selected?.label ?? '设备详情'"
      :subtitle="selected?.subtitle"
      @close="selectedKey = null"
      ><div v-if="selected" class="entity-detail drawer-detail">
        <dl>
          <div>
            <dt>活动连接</dt>
            <dd>{{ selected.connections.length }}</dd>
          </div>
          <div>
            <dt>上传</dt>
            <dd>{{ formatBytes(selected.upload) }}</dd>
          </div>
          <div>
            <dt>下载</dt>
            <dd>{{ formatBytes(selected.download) }}</dd>
          </div>
        </dl>
        <h3>进程</h3>
        <ul>
          <li v-for="connection in selected.connections" :key="connection.id">
            <span>{{ connection.metadata.process || "未知进程" }}</span
            ><small>{{
              connection.metadata.host ||
              connection.metadata.destinationIP ||
              "未知目标"
            }}</small>
          </li>
        </ul><p class="inline-note">设备身份仅代表当前连接中的来源 IP，不是 DHCP 租约记录。</p><button type="button" class="danger-button" :disabled="closing" @click="closeSelected">{{ closing ? '正在关闭…' : '关闭该地址的全部连接' }}</button>
      </div></DetailDrawer
    >
  </div>
</template>
