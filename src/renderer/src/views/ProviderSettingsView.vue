<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useProfilesStore } from '../stores/profiles'
import type { ConfigEdit } from '@shared/profiles'

const profilesStore = useProfilesStore()

const mode = ref('rule')
const mixedPort = ref('')
const saving = ref(false)

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'rule', label: '规则判定' },
  { value: 'global', label: '全局代理' },
  { value: 'direct', label: '直接连接' }
]

const activeId = computed(() => profilesStore.currentId)
const activeMeta = computed(() => profilesStore.active)

async function loadActiveProfile(): Promise<void> {
  await profilesStore.load()
  const id = profilesStore.currentId
  if (!id) return
  const profile = await profilesStore.get(id)
  if (!profile) return
  const m = parseScalar(profile.document, 'mode')
  if (m !== null) mode.value = m
  const port = parseScalar(profile.document, 'mixed-port')
  if (port !== null) mixedPort.value = port
}

function parseScalar(document: string, key: string): string | null {
  for (const line of document.split('\n')) {
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (match && match[1] === key) return (match[2] ?? '').trim().replace(/\s+#.*$/, '')
  }
  return null
}

async function save(): Promise<void> {
  const id = activeId.value
  if (!id) return
  saving.value = true
  const edits: ConfigEdit[] = [{ key: 'mode', value: mode.value }]
  if (mixedPort.value.trim()) edits.push({ key: 'mixed-port', value: mixedPort.value.trim() })
  try {
    await profilesStore.editDocument(id, edits)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadActiveProfile()
})
</script>

<template>
  <div class="page-shell provider-settings">
    <h1>代理设置</h1>

    <p v-if="!activeMeta" class="inline-note">请先在「配置」页导入并启用一个配置文件。</p>
    <template v-else>
      <p class="inline-note">当前配置文件：{{ activeMeta.name }}</p>

      <p v-if="profilesStore.lastError" class="inline-error">{{ profilesStore.lastError }}</p>

      <section class="section-caption"><span>运行模式</span></section>
      <div class="mode-selector import-card" role="tablist" aria-label="运行模式">
        <button
          v-for="option in MODE_OPTIONS"
          :key="option.value"
          :class="{ selected: mode === option.value }"
          type="button"
          @click="mode = option.value"
        >{{ option.label }}</button>
      </div>

      <section class="section-caption"><span>监听端口</span></section>
      <div class="import-card">
        <input v-model="mixedPort" class="field" placeholder="mixed-port，例如 7890" />
        <div class="import-row">
          <button type="button" @click="save" :disabled="saving">保存</button>
        </div>
      </div>

      <p class="inline-note">未知配置字段与注释会被原样保留。</p>
    </template>
  </div>
</template>

<style scoped>
.import-card {
  background: var(--app-surface);
  border-radius: var(--radius-large);
  padding: 14px;
  box-shadow: var(--app-shadow);
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 18px;
}
.mode-selector {
  flex-direction: row;
}
.mode-selector button {
  flex: 1;
  background: transparent;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  padding: 9px;
  color: var(--app-text);
}
.mode-selector button.selected {
  background: var(--app-purple);
  color: #fff;
  border-color: var(--app-purple);
}
.field {
  width: 100%;
  box-sizing: border-box;
  background: var(--app-surface-solid);
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  padding: 9px 11px;
  color: var(--app-text);
}
.import-row {
  display: flex;
  justify-content: flex-end;
}
.import-card button {
  background: var(--app-purple);
  color: #fff;
  border: 0;
  border-radius: var(--radius-control);
  padding: 8px 14px;
}
.inline-note {
  color: var(--app-muted);
  font-size: 13px;
}
.inline-error {
  color: #e05b5b;
  font-size: 12px;
}
</style>
