<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useConnectionsStore } from "../stores/connections";
import { useOverridesStore } from "../stores/overrides";
import { usePoliciesStore } from "../stores/policies";
import { groupConnectionsByProcess } from "../lib/connection-groups";
import { formatBytes } from "../lib/format";
import AppIcon from "../components/AppIcon.vue";
import ProcessIcon from "../components/ProcessIcon.vue";
import DetailDrawer from "../components/DetailDrawer.vue";
import AppSelect from "../components/AppSelect.vue";
import EmptyState from "../components/EmptyState.vue";
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
  { value: "path", label: "完整路径 · 仅匹配这个程序", disabled: !processPath.value },
  { value: "name", label: "进程名 · 匹配同名程序" },
]);
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
const processPath = computed(() => selected.value?.connections[0]?.metadata.processPath?.trim() ?? "");
const targetOptions = computed(() => [
  { value: "DIRECT", label: "直连 · DIRECT" },
  ...policies.groups.filter((group) => group.name !== "DIRECT" && !/[\r\n,]/.test(group.name)).map((group) => ({ value: group.name, label: group.name })),
]);
const draft = computed(() => {
  if (!selected.value || selected.value.label === "未知进程") return null;
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
    if (!saved) throw new Error(overrides.lastError ?? "保存失败");
    const created = overrides.items.find((item) => !before.has(item.id));
    if (created) lastCreated.value = { id: created.id, rule: draft.value.rule };
  } catch (error) {
    ruleError.value = error instanceof Error ? error.message : "保存失败";
  } finally { savingRule.value = false; }
}

async function undoRule(): Promise<void> {
  if (!lastCreated.value || savingRule.value) return;
  savingRule.value = true;
  const removed = await overrides.remove(lastCreated.value.id);
  if (removed) lastCreated.value = null;
  else ruleError.value = overrides.lastError ?? "撤销失败";
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
        <h1>进程</h1>
        <small aria-live="polite">{{
          store.status === "live"
            ? `${groups.length} 个活动进程 · 点击查看详情`
            : "正在连接"
        }}</small>
      </div>
      <AppSelect v-model="sort" :options="SORT_OPTIONS" label="进程排序方式" />
    </header>
    <div v-if="lastCreated" class="process-rule-notice surface-card" role="status">
      <span><strong>分流规则已保存</strong><small>{{ lastCreated.rule }} · 下次重载配置后生效</small></span>
      <button type="button" :disabled="savingRule" @click="undoRule">撤销</button>
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
        <section class="process-rule-editor" aria-label="为进程创建分流规则">
          <h3>创建分流规则</h3>
          <p>生成全局覆写，规则置于订阅规则之前；不会修改订阅文件。保存后可在「覆写」中编辑或删除。</p>
          <label>匹配方式<AppSelect v-model="match" :options="matchOptions" label="进程规则匹配方式" /></label>
          <label>出站策略<AppSelect v-model="target" :options="targetOptions" label="进程出站策略" /></label>
          <div class="process-rule-preview"><span>保存前预览</span><code>{{ draft?.rule ?? '当前进程信息不足，无法生成规则' }}</code></div>
          <button type="button" class="process-rule-save" :disabled="!draft || savingRule || !targetOptions.some((option) => option.value === target)" @click="saveRule">{{ savingRule ? '保存中…' : '保存规则' }}</button>
        </section>
        <h3>目标</h3>
        <ul>
          <li v-for="connection in selected.connections" :key="connection.id">
            <span>{{
              connection.metadata.host ||
              connection.metadata.destinationIP ||
              "未知目标"
            }}</span
            ><small>{{ formatConnectionChain(connection.chains) }}</small>
          </li>
        </ul>
      </div></DetailDrawer
    >
  </div>
</template>

<style scoped>
.process-list-icon{width:29px;height:29px;border-radius:7px;background:rgba(127,127,127,.14)}
.process-rule-notice{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;margin:12px 0}
.process-rule-notice span{display:flex;flex-direction:column;gap:3px;min-width:0}
.process-rule-notice small{color:var(--app-muted);overflow-wrap:anywhere}
.process-rule-notice button{border:1px solid var(--app-divider);background:transparent;color:var(--app-text);border-radius:8px;padding:7px 13px;cursor:pointer}
.process-rule-editor{display:grid;gap:12px;margin:20px 0;padding:17px;border:1px solid var(--app-divider);border-radius:14px;background:color-mix(in srgb,var(--app-surface) 78%,var(--app-bg))}
.process-rule-editor h3{margin:0}
.process-rule-editor p{margin:0;color:var(--app-muted);font-size:11px;line-height:1.5}
.process-rule-editor label{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px}
.process-rule-preview{display:grid;gap:5px;padding:11px;border-radius:8px;background:color-mix(in srgb,var(--app-bg) 78%,var(--app-surface));min-width:0}
.process-rule-preview span{font-size:11px;color:var(--app-muted)}
.process-rule-preview code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}
.process-rule-save{justify-self:end;border:0;border-radius:8px;background:var(--app-accent);color:white;padding:8px 14px;cursor:pointer}
.process-rule-save:disabled{opacity:.5;cursor:not-allowed}
</style>
