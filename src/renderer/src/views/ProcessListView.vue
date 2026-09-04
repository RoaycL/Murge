<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useConnectionsStore } from "../stores/connections";
import { groupConnectionsByProcess } from "../lib/connection-groups";
import { formatBytes } from "../lib/format";
import AppIcon from "../components/AppIcon.vue";
import DetailDrawer from "../components/DetailDrawer.vue";
import AppSelect from "../components/AppSelect.vue";
import EmptyState from "../components/EmptyState.vue";

const store = useConnectionsStore();
const selectedKey = ref<string | null>(null);
const sort = ref<"traffic" | "name">("traffic");
const SORT_OPTIONS = [
  { value: "traffic", label: "按流量排序" },
  { value: "name", label: "按名称排序" },
] as const;
const groups = computed(() => {
  const rows = groupConnectionsByProcess(store.snapshot?.connections ?? []);
  return sort.value === "name"
    ? [...rows].sort((a, b) => a.label.localeCompare(b.label))
    : rows;
});
const selected = computed(
  () => groups.value.find((group) => group.key === selectedKey.value) ?? null,
);
onMounted(store.connect);
onUnmounted(store.disconnect);
</script>
<template>
  <div class="page-shell list-detail-page">
    <header class="page-toolbar">
      <div>
        <h1>进程</h1>
        <small aria-live="polite">{{
          store.status === "live"
            ? `${groups.length} 个活动进程 · 点击查看详情`
            : "正在连接"
        }}</small>
      </div>
      <AppSelect v-model="sort" :options="SORT_OPTIONS" label="进程排序方式" />
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
        <i><AppIcon name="processes" :size="16" /></i
        ><span
          >{{ group.label }}<small>{{ group.subtitle }}</small></span
        ><strong
          >{{ formatBytes(group.upload + group.download)
          }}<small>{{ group.connections.length }} 个连接</small></strong
        ><AppIcon name="next" :size="15" />
      </button>
      <EmptyState v-if="!groups.length" icon="processes" title="暂无活动进程" detail="产生网络连接的进程会自动汇总到这里。" />
    </section>
    <DetailDrawer
      :open="Boolean(selected)"
      :title="selected?.label ?? '进程详情'"
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
        <h3>目标</h3>
        <ul>
          <li v-for="connection in selected.connections" :key="connection.id">
            <span>{{
              connection.metadata.host ||
              connection.metadata.destinationIP ||
              "未知目标"
            }}</span
            ><small>{{ connection.chains.join(" → ") || "DIRECT" }}</small>
          </li>
        </ul>
      </div></DetailDrawer
    >
  </div>
</template>
