<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useKernelManagerStore } from '../stores/kernel-manager'

const emit = defineEmits<{ (e: 'close'): void }>()

const kernelManager = useKernelManagerStore()

const search = ref('')
const selected = ref<string | null>(null)

const state = computed(() => kernelManager.state)

const filteredVersions = computed(() => {
  const q = search.value.trim().toLowerCase()
  const versions = state.value.versions
  if (!q) return versions
  return versions.filter((version) => version.toLowerCase().includes(q))
})

const installing = computed(
  () => state.value.installing !== null
)
const selectedIsCurrent = computed(() => selected.value === state.value.effectiveVersion)

function selectVersion(version: string): void {
  selected.value = version
}

async function refresh(): Promise<void> {
  await kernelManager.listVersions()
}

onMounted(() => {
  selected.value = state.value.specificVersion
  if (state.value.specificVersionsSupported) void kernelManager.listVersions()
})

async function confirmInstall(): Promise<void> {
  if (!selected.value || installing.value) return
  const applied = await kernelManager.install(selected.value)
  if (applied) emit('close')
}
</script>

<template>
  <div class="km-backdrop" @click.self="emit('close')">
    <div class="km-modal" role="dialog" aria-modal="true" aria-label="选择特定版本">
      <header class="km-head">
        <h2>选择特定版本</h2>
        <p v-if="state.specificVersionsSupported">从 mihomo 官方版本中选择。下载、摘要校验、安装和运行版本回读全部成功后才会切换。</p>
        <p v-else>当前 Windows 安全服务使用随应用安装的稳定内核。更新应用时会同步更新内核版本。</p>
      </header>

      <div v-if="state.specificVersionsSupported" class="km-toolbar">
        <input
          v-model="search"
          class="km-search"
          type="search"
          placeholder="搜索版本..."
          aria-label="搜索版本"
        />
        <button
          type="button"
          class="km-refresh"
          :disabled="state.versionsLoading"
          @click="refresh"
        >
          {{ state.versionsLoading ? '刷新中…' : '刷新' }}
        </button>
      </div>

      <p v-if="!state.specificVersionsSupported" class="km-hint">当前版本：{{ state.effectiveVersion || state.stableVersion || '内置稳定版' }}</p>
      <p v-else-if="state.error" class="inline-error">{{ state.error }}</p>
      <p v-else-if="state.versionsLoading" class="km-hint">正在获取版本列表…</p>
      <p v-else-if="!filteredVersions.length" class="km-hint">
        {{ search ? '没有匹配的版本' : '暂无可用版本' }}
      </p>

      <ul v-else-if="state.specificVersionsSupported" class="km-list">
        <li v-for="version in filteredVersions" :key="version">
          <button
            type="button"
            :class="{ selected: selected === version, installing: state.installing === version }"
            :disabled="installing"
            @click="selectVersion(version)"
          >
            <span>{{ version }}</span>
            <em v-if="state.installing === version">安装中…</em>
            <em v-else-if="state.effectiveVersion === version">当前</em>
          </button>
        </li>
      </ul>

      <footer class="km-actions">
        <button type="button" class="km-cancel" :disabled="installing" @click="emit('close')">
          取消
        </button>
        <button
          v-if="state.specificVersionsSupported"
          type="button"
          class="km-install"
          :disabled="!selected || installing || selectedIsCurrent"
          @click="confirmInstall"
        >
          {{ installing ? '安装中…' : '安装版本' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.km-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.km-modal {
  display: flex;
  flex-direction: column;
  width: min(920px, calc(100vw - 40px));
  max-height: min(82vh, 720px);
  background: var(--app-surface-solid);
  border: 1px solid var(--app-divider);
  border-radius: 14px;
  box-shadow: var(--app-shadow);
  padding: 18px;
}
.km-head h2 { margin: 0 0 5px; font-size: 15px; }
.km-head p { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; }
.km-toolbar { display: flex; gap: 8px; margin-top: 14px; }
.km-search {
  flex: 1;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
}
.km-refresh {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
}
.km-refresh:disabled { opacity: 0.6; }
.km-hint { margin: 12px 0 0; color: var(--app-muted); font-size: 11px; }
.km-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.km-list button {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: left;
}
.km-list button.selected { border-color: var(--app-blue); background: rgba(21, 135, 248, 0.08); }
.km-list button:disabled { opacity: 0.6; }
.km-list em { color: var(--app-muted); font-size: 10px; font-style: normal; }
.km-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.km-cancel,
.km-install {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.km-cancel { background: rgba(127, 127, 127, 0.14); color: inherit; }
.km-install { background: var(--app-blue); color: white; }
.km-cancel:disabled,
.km-install:disabled { opacity: 0.6; }
@media (max-width: 560px) {
  .km-modal { width: calc(100vw - 20px); max-height: calc(100vh - 20px); padding: 14px; }
  .km-toolbar { align-items: stretch; }
  .km-refresh { flex: 0 0 auto; }
  .km-list { grid-template-columns: 1fr; }
}
</style>
