<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useProfilesStore } from '../stores/profiles'
import type { ValidationResult } from '@shared/profiles'

const profilesStore = useProfilesStore()

const url = ref('')
const importName = ref('')
const document = ref('')
const importing = ref(false)
const validation = ref<ValidationResult | null>(null)

const SOURCE_LABELS: Record<string, string> = {
  url: '订阅',
  file: '文件',
  manual: '手动'
}

function sourceLabel(type: string): string {
  return SOURCE_LABELS[type] ?? type
}

async function importFromUrl(): Promise<void> {
  if (!url.value.trim()) return
  importing.value = true
  try {
    await profilesStore.importFromUrl(importName.value.trim() || url.value.trim(), url.value.trim())
  } finally {
    importing.value = false
  }
}

async function importManual(): Promise<void> {
  if (!document.value.trim()) return
  importing.value = true
  try {
    await profilesStore.importProfile({
      name: importName.value.trim() || '手动配置',
      document: document.value,
      source: { type: 'manual' }
    })
    document.value = ''
  } finally {
    importing.value = false
  }
}

async function previewValidation(): Promise<void> {
  validation.value = await profilesStore.validate(document.value)
}

async function activate(id: string): Promise<void> {
  try {
    await profilesStore.activate(id)
  } catch {
    /* store surfaces the failure */
  }
}

async function remove(id: string): Promise<void> {
  try {
    await profilesStore.remove(id)
  } catch {
    /* store surfaces the failure */
  }
}

async function rename(id: string): Promise<void> {
  const meta = profilesStore.profiles.find((entry) => entry.id === id)
  const next = prompt('重命名配置文件', meta?.name ?? '')
  if (next && next.trim()) {
    try {
      await profilesStore.rename(id, next.trim())
    } catch {
      /* store surfaces the failure */
    }
  }
}

onMounted(() => {
  void profilesStore.load()
})
</script>

<template>
  <div class="page-shell config-view">
    <h1>配置</h1>

    <p v-if="profilesStore.lastError" class="inline-error">{{ profilesStore.lastError }}</p>

    <section class="section-caption"><span>导入订阅</span></section>
    <div class="import-card">
      <input v-model="importName" class="field" placeholder="配置文件名称（可选）" />
      <input v-model="url" class="field" placeholder="订阅地址 https://…" />
      <button type="button" @click="importFromUrl" :disabled="importing || !url.trim()">导入</button>
    </div>

    <section class="section-caption">
      <span>手动导入</span>
      <button type="button" @click="previewValidation">校验</button>
    </section>
    <div class="import-card">
      <textarea
        v-model="document"
        class="field document"
        spellcheck="false"
        placeholder="粘贴 mihomo 配置 YAML…"
      />
      <div class="import-row">
        <button type="button" @click="importManual" :disabled="importing || !document.trim()">导入</button>
      </div>
      <p v-if="validation && !validation.ok" class="inline-error">
        {{ validation.issues.map((issue) => issue.message).join('；') }}
      </p>
      <p v-else-if="validation?.ok" class="inline-ok">配置有效</p>
    </div>

    <section class="section-caption"><span>配置文件</span></section>
    <div class="profiles-list">
      <div v-if="profilesStore.status === 'loading' || profilesStore.status === 'idle'" class="empty-state">
        <p>正在加载配置…</p>
      </div>
      <div
        v-for="meta in profilesStore.ordered"
        :key="meta.id"
        class="profile-row"
        :class="{ active: meta.active }"
      >
        <div class="profile-info">
          <span class="profile-name">{{ meta.name }}</span>
          <span class="profile-meta">{{ sourceLabel(meta.source.type) }} · {{ meta.size }} B</span>
        </div>
        <span v-if="meta.active" class="badge">使用中</span>
        <div class="profile-actions">
          <button v-if="!meta.active" type="button" @click="activate(meta.id)">启用</button>
          <button type="button" @click="rename(meta.id)">重命名</button>
          <button type="button" class="danger" @click="remove(meta.id)">删除</button>
        </div>
      </div>
      <div v-if="profilesStore.status === 'ready' && profilesStore.ordered.length === 0" class="empty-state">
        <p>尚无配置文件</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-view .import-card {
  background: var(--app-surface);
  border-radius: var(--radius-large);
  padding: 14px;
  box-shadow: var(--app-shadow);
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 18px;
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
.field.document {
  min-height: 120px;
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 12px;
  resize: vertical;
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
.import-card button:disabled {
  opacity: 0.5;
}
.profiles-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.profile-row {
  background: var(--app-surface);
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-large);
  padding: 12px 14px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.profile-row.active {
  border-color: var(--app-purple);
}
.profile-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.profile-name {
  font-weight: 600;
}
.profile-meta {
  color: var(--app-muted);
  font-size: 12px;
}
.badge {
  background: var(--app-purple);
  color: #fff;
  font-size: 11px;
  border-radius: var(--radius-control);
  padding: 3px 8px;
}
.profile-actions {
  display: flex;
  gap: 6px;
}
.profile-actions button {
  background: transparent;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  padding: 5px 10px;
  color: var(--app-text);
}
.profile-actions button.danger {
  color: #e05b5b;
}
.inline-error {
  color: #e05b5b;
  font-size: 12px;
}
.inline-ok {
  color: var(--app-green);
  font-size: 12px;
}
</style>
