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

function selectVersion(version: string): void {
  selected.value = version
}

async function refresh(): Promise<void> {
  await kernelManager.listVersions()
}

onMounted(() => {
  selected.value = state.value.specificVersion
  void kernelManager.listVersions()
})

async function confirmInstall(): Promise<void> {
  if (!selected.value || installing.value) return
  await kernelManager.install(selected.value)
  if (!kernelManager.state.error) emit('close')
}
</script>

<template>
  <div class="km-backdrop" @click.self="emit('close')">
    <div class="km-modal" role="dialog" aria-modal="true" aria-label="选择特定版本">
      <header class="km-head">
        <h2>选择特定版本</h2>
        <p>安装指定版本前会校验官方发布摘要与大小；下载结束后立即校验并安装。</p>
      </header>

      <div class="km-toolbar">
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

      <p v-if="state.error" class="inline-error">{{ state.error }}</p>
      <p v-else-if="state.versionsLoading" class="km-hint">正在获取版本列表…</p>
      <p v-else-if="!filteredVersions.length" class="km-hint">
        {{ search ? '没有匹配的版本' : '暂无可用版本' }}
      </p>

      <ul v-else class="km-list">
        <li v-for="version in filteredVersions" :key="version">
          <button
            type="button"
            :class="{ selected: selected === version, installing: state.installing === version }"
            :disabled="installing"
            @click="selectVersion(version)"
          >
            <span>{{ version }}</span>
            <em v-if="state.installing === version">安装中…</em>
          </button>
        </li>
      </ul>

      <footer class="km-actions">
        <button type="button" class="km-cancel" :disabled="installing" @click="emit('close')">
          取消
        </button>
        <button
          type="button"
          class="km-install"
          :disabled="!selected || installing"
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
  width: 460px;
  max-height: 78vh;
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
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.km-list button {
  display: flex;
  min-height: 32px;
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
</style>
