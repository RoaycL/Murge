<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useProfilesStore } from '../stores/profiles'
import { useProvidersStore } from '../stores/providers'
import { useKernelStore } from '../stores/kernel'
import OverridesPanel from '../components/OverridesPanel.vue'
import DnsSettingsPanel from '../components/DnsSettingsPanel.vue'
import SnifferSettingsPanel from '../components/SnifferSettingsPanel.vue'
import TunConfigPanel from '../components/TunConfigPanel.vue'
import TunLifecyclePanel from '../components/TunLifecyclePanel.vue'
import type { ValidationResult } from '@shared/profiles'

const profilesStore = useProfilesStore()
const providersStore = useProvidersStore()
const kernel = useKernelStore()

const url = ref('')
const importName = ref('')
const document = ref('')
const localFile = ref<File | null>(null)
const localFileInput = ref<HTMLInputElement | null>(null)
const urlInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const validation = ref<ValidationResult | null>(null)
const proxyMode = ref<'direct' | 'system'>('direct')
const showFilePanel = ref(false)
const showManualPanel = ref(false)

const menuAnchor = ref<{ id: string; top: number; left: number } | null>(null)
const refreshingAll = ref(false)
const batchResult = ref<{ updated: number; failed: number } | null>(null)

const SOURCE_BADGE: Record<string, string> = {
  url: '远程',
  file: '本地',
  manual: '手动'
}

const CARD_PALETTE = ['--app-blue', '--app-pink', '--app-green', '--app-cyan', '--app-purple']

function sourceBadge(type: string): string {
  return SOURCE_BADGE[type] ?? type
}

/** Deterministic accent color per profile so cards look varied, like the reference. */
function cardColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  const token = CARD_PALETTE[hash % CARD_PALETTE.length]
  return `var(${token})`
}

function relativeTime(value: number | string): string {
  const ms = typeof value === 'string' ? Date.parse(value) : value
  if (Number.isNaN(ms)) return '—'
  const diff = Date.now() - ms
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo} 个月前`
  const yr = Math.floor(mo / 12)
  return `${yr} 年前`
}

function toggleMenu(id: string, event: MouseEvent): void {
  if (menuAnchor.value?.id === id) {
    menuAnchor.value = null
    return
  }
  const button = event.currentTarget as HTMLElement
  const rect = button.getBoundingClientRect()
  const top = Math.min(rect.bottom + 4, window.innerHeight - 132)
  menuAnchor.value = { id, top, left: rect.left }
}

function closeMenu(): void {
  menuAnchor.value = null
}

async function importFromUrl(): Promise<void> {
  if (!url.value.trim()) return
  importing.value = true
  try {
    await profilesStore.importFromUrl(importName.value.trim() || url.value.trim(), url.value.trim(), true)
  } finally {
    importing.value = false
  }
}

async function pasteUrl(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) url.value = text.trim()
  } catch {
    urlInput.value?.focus()
  }
}

function selectLocalFile(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  localFile.value = input.files?.[0] ?? null
}

async function importLocalFile(): Promise<void> {
  const file = localFile.value
  if (!file) return
  importing.value = true
  try {
    const raw = await file.text()
    const fallbackName = file.name.replace(/\.(?:ya?ml)$/i, '') || file.name
    await profilesStore.importProfile({
      name: importName.value.trim() || fallbackName,
      document: raw,
      source: { type: 'file', path: file.name },
      activate: true
    })
    localFile.value = null
    if (localFileInput.value) localFileInput.value.value = ''
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
      source: { type: 'manual' },
      activate: true
    })
    document.value = ''
    validation.value = null
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

/** Card ↻: re-apply the profile to the kernel (activate re-materializes the config). */
async function cardRefresh(id: string): Promise<void> {
  await activate(id)
  closeMenu()
}

async function remove(id: string): Promise<void> {
  try {
    await profilesStore.remove(id)
  } catch {
    /* store surfaces the failure */
  }
  closeMenu()
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
  closeMenu()
}

async function refreshAllResources(): Promise<void> {
  refreshingAll.value = true
  batchResult.value = null
  try {
    batchResult.value = await providersStore.refreshAllProviders()
  } finally {
    refreshingAll.value = false
  }
}

async function loadProviders(): Promise<void> {
  if (kernel.status.phase !== 'running') return
  await Promise.all([
    providersStore.loadProxyProviders(),
    providersStore.loadRuleProviders()
  ])
}

onMounted(() => {
  void profilesStore.load()
  void loadProviders()
})

watch(
  () => kernel.status.phase,
  (phase, previous) => {
    if (phase === 'running' && previous !== 'running') void loadProviders()
  }
)

const activeCount = computed(() => profilesStore.profiles.filter((entry) => entry.active).length)
const activeProfileId = computed(() => profilesStore.profiles.find((entry) => entry.active)?.id ?? null)
const hasResources = computed(
  () => Object.keys(providersStore.proxyProviders).length + Object.keys(providersStore.ruleProviders).length > 0
)
</script>

<template>
  <div class="page-shell config-view">
    <header class="config-header">
      <h1>订阅管理</h1>
      <p class="config-subtitle">
        共 {{ profilesStore.ordered.length }} 个配置<template v-if="activeCount"> · 使用中 {{ activeCount }}</template>
      </p>
    </header>

    <p v-if="profilesStore.lastError" class="inline-error" role="alert">{{ profilesStore.lastError }}</p>

    <section class="import-bar" aria-label="导入订阅">
      <input
        ref="urlInput"
        v-model="url"
        class="url-field"
        aria-label="订阅地址"
        placeholder="请输入您的订阅网址"
        @keyup.enter="importFromUrl"
      />
      <button type="button" class="icon-button" aria-label="粘贴订阅地址" title="粘贴" @click="pasteUrl">⧉</button>
      <select v-model="proxyMode" class="proxy-select" aria-label="拉取方式">
        <option value="direct">直连</option>
        <option value="system">系统代理</option>
      </select>
      <button type="button" class="import-button" :disabled="importing || !url.trim()" @click="importFromUrl">
        导入
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="导入本地配置文件"
        title="本地文件"
        :class="{ active: showFilePanel }"
        @click="showFilePanel = !showFilePanel"
      >▤</button>
      <button
        type="button"
        class="icon-button"
        aria-label="手动导入配置"
        title="手动导入"
        :class="{ active: showManualPanel }"
        @click="showManualPanel = !showManualPanel"
      >＋</button>
    </section>
    <p v-if="proxyMode === 'system'" class="import-note">订阅暂由系统直连拉取，系统代理方式即将支持。</p>

    <section v-if="showFilePanel" class="import-panel">
      <input
        ref="localFileInput"
        class="file-input"
        type="file"
        accept=".yaml,.yml,text/yaml,application/yaml"
        aria-label="选择本地 mihomo 配置文件"
        @change="selectLocalFile"
      />
      <div class="import-row">
        <span v-if="localFile" class="local-file-name">{{ localFile.name }}</span>
        <button type="button" class="panel-button" :disabled="importing || !localFile" @click="importLocalFile">
          导入并启用
        </button>
        <button type="button" class="panel-button ghost" @click="showFilePanel = false">关闭</button>
      </div>
    </section>

    <section v-if="showManualPanel" class="import-panel">
      <textarea
        v-model="document"
        class="field document"
        spellcheck="false"
        aria-label="mihomo 配置 YAML"
        placeholder="粘贴 mihomo 配置 YAML…"
      />
      <div class="import-row">
        <button type="button" class="panel-button" @click="previewValidation">校验</button>
        <button type="button" class="panel-button" :disabled="importing || !document.trim()" @click="importManual">
          导入并启用
        </button>
        <button type="button" class="panel-button ghost" @click="showManualPanel = false">关闭</button>
      </div>
      <p v-if="validation && !validation.ok" class="inline-error" role="alert">
        {{ validation.issues.map((issue) => issue.message).join('；') }}
      </p>
      <p v-else-if="validation?.ok" class="inline-ok" aria-live="polite">配置有效</p>
    </section>

    <div v-if="profilesStore.status === 'loading' || profilesStore.status === 'idle'" class="empty-state">
      <p>正在加载配置…</p>
    </div>
    <div v-else-if="profilesStore.ordered.length === 0" class="empty-state">
      <p>尚无配置，请从上方导入一个订阅。</p>
    </div>
    <div v-else class="profiles-grid">
      <article
        v-for="meta in profilesStore.ordered"
        :key="meta.id"
        class="profile-card"
        :class="{ active: meta.active }"
        tabindex="0"
        role="button"
        :aria-label="`使用配置 ${meta.name}`"
        @click="activate(meta.id)"
        @keyup.enter="activate(meta.id)"
        @keyup.space.prevent="activate(meta.id)"
      >
        <div class="card-top">
          <span class="card-name" :style="{ color: cardColor(meta.id) }">{{ meta.name }}</span>
          <div class="card-actions">
            <button
              type="button"
              class="icon-button small"
              aria-label="重新应用该配置"
              title="重新应用"
              @click.stop="cardRefresh(meta.id)"
            >↻</button>
            <button
              type="button"
              class="icon-button small"
              aria-label="更多操作"
              title="更多"
              @click.stop="toggleMenu(meta.id, $event)"
            >⋮</button>
          </div>
        </div>
        <div class="card-bottom">
          <span class="pill-badge">{{ sourceBadge(meta.source.type) }}</span>
          <span v-if="meta.active" class="pill-badge active-badge">使用中</span>
          <span class="card-time">{{ relativeTime(meta.updatedAt) }}</span>
        </div>
      </article>
    </div>

    <!-- 全屏遮罩关闭卡片菜单 -->
    <div v-if="menuAnchor" class="menu-backdrop" @click="closeMenu" />
    <div v-if="menuAnchor" class="card-menu" role="menu" :style="{ top: `${menuAnchor.top}px`, left: `${menuAnchor.left}px` }" @click.stop>
      <template v-for="meta in profilesStore.ordered" :key="meta.id">
        <template v-if="meta.id === menuAnchor.id">
          <button v-if="!meta.active" type="button" role="menuitem" @click="activate(meta.id); closeMenu()">使用</button>
          <button type="button" role="menuitem" @click="rename(meta.id)">重命名</button>
          <button type="button" role="menuitem" class="danger" @click="remove(meta.id)">删除</button>
        </template>
      </template>
    </div>

    <section class="resource-section">
      <header class="section-heading">
        <div>
          <h2>外部资源管理</h2>
          <p class="section-sub">配置文件中引用的代理集与规则集，可一次全部更新。</p>
        </div>
        <button
          type="button"
          class="update-all-button"
          :disabled="refreshingAll || kernel.status.phase !== 'running' || !hasResources"
          @click="refreshAllResources"
        >
          {{ refreshingAll ? '更新中…' : '一键更新' }}
        </button>
      </header>

      <p v-if="batchResult" class="batch-result" aria-live="polite">
        更新完成：成功 {{ batchResult.updated }} 项<template v-if="batchResult.failed">，失败 {{ batchResult.failed }} 项</template>。
      </p>

      <p v-if="kernel.status.phase !== 'running'" class="empty-note">启动内核后即可管理外部资源。</p>
      <template v-else>
        <div class="resource-group">
          <h3 class="resource-group-title">代理集</h3>
          <div v-if="providersStore.proxyStatus === 'loading' || providersStore.proxyStatus === 'idle'" class="empty-state">
            <p>正在读取代理集…</p>
          </div>
          <div v-else-if="providersStore.orderedProxyProviders.length === 0" class="empty-state">
            <p>当前配置未引用外部代理集。</p>
          </div>
          <div v-else class="resource-list">
            <div v-for="provider in providersStore.orderedProxyProviders" :key="provider.name" class="resource-row">
              <div class="resource-info">
                <span class="resource-name">{{ provider.name }}</span>
                <span class="resource-meta">
                  {{ provider.vehicleType ?? provider.type }} · {{ provider.proxies?.length ?? 0 }} 节点
                  <template v-if="provider.updatedAt"> · {{ relativeTime(provider.updatedAt) }}</template>
                </span>
                <span v-if="providersStore.opOf(provider.name).error" class="resource-error">
                  {{ providersStore.opOf(provider.name).error }}
                </span>
              </div>
              <button
                type="button"
                class="resource-refresh"
                :disabled="providersStore.opOf(provider.name).refreshing"
                @click="providersStore.refreshProxyProvider(provider.name)"
              >{{ providersStore.opOf(provider.name).refreshing ? '更新中' : '更新' }}</button>
            </div>
          </div>
        </div>

        <div class="resource-group">
          <h3 class="resource-group-title">规则集</h3>
          <div v-if="providersStore.ruleStatus === 'loading' || providersStore.ruleStatus === 'idle'" class="empty-state">
            <p>正在读取规则集…</p>
          </div>
          <div v-else-if="providersStore.orderedRuleProviders.length === 0" class="empty-state">
            <p>当前配置未引用外部规则集。</p>
          </div>
          <div v-else class="resource-list">
            <div v-for="provider in providersStore.orderedRuleProviders" :key="provider.name" class="resource-row">
              <div class="resource-info">
                <span class="resource-name">{{ provider.name }}</span>
                <span class="resource-meta">
                  {{ provider.vehicleType ?? provider.type }} · {{ provider.ruleCount ?? 0 }} 条规则
                  <template v-if="provider.updatedAt"> · {{ relativeTime(provider.updatedAt) }}</template>
                </span>
                <span v-if="providersStore.opOf(provider.name).error" class="resource-error">
                  {{ providersStore.opOf(provider.name).error }}
                </span>
              </div>
              <button
                type="button"
                class="resource-refresh"
                :disabled="providersStore.opOf(provider.name).refreshing"
                @click="providersStore.refreshRuleProvider(provider.name)"
              >{{ providersStore.opOf(provider.name).refreshing ? '更新中' : '更新' }}</button>
            </div>
          </div>
        </div>
      </template>
    </section>

    <overrides-panel :active-profile-id="activeProfileId" />
    <dns-settings-panel />
    <sniffer-settings-panel />
    <tun-config-panel />
    <tun-lifecycle-panel />
  </div>
</template>

<style scoped>
.config-view {
  display: flex;
  flex-direction: column;
}
.config-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 18px;
}
.config-subtitle {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}

.import-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--app-surface);
  border-radius: var(--radius-large);
  border: 1px solid var(--app-surface-border);
  box-shadow: var(--app-shadow);
  padding: 10px;
  margin-bottom: 8px;
}
.url-field {
  flex: 1;
  min-width: 0;
  background: var(--app-surface-solid);
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  padding: 9px 12px;
  color: var(--app-text);
}
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--app-muted);
  font-size: 16px;
  line-height: 1;
  flex: 0 0 auto;
}
.icon-button:hover {
  color: var(--app-text);
  border-color: var(--app-muted);
}
.icon-button.active {
  color: var(--app-purple);
  border-color: var(--app-purple);
}
.icon-button.small {
  width: 26px;
  height: 26px;
  font-size: 14px;
}
.proxy-select {
  height: 36px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: var(--app-text);
  padding: 0 8px;
}
.import-button {
  height: 36px;
  padding: 0 18px;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--app-purple);
  color: #fff;
  font-weight: 600;
  flex: 0 0 auto;
}
.import-button:disabled {
  opacity: 0.5;
}
.import-note {
  margin: 6px 0 0;
  color: var(--app-muted);
  font-size: 11px;
}

.import-panel {
  background: var(--app-surface);
  border: 1px solid var(--app-surface-border);
  border-radius: var(--radius-large);
  box-shadow: var(--app-shadow);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 12px 0;
}
.file-input {
  color: var(--app-muted);
}
.import-row {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
}
.local-file-name {
  min-width: 0;
  overflow: hidden;
  color: var(--app-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: auto;
}
.panel-button {
  border: 0;
  border-radius: var(--radius-control);
  background: var(--app-purple);
  color: #fff;
  padding: 8px 14px;
}
.panel-button:disabled {
  opacity: 0.5;
}
.panel-button.ghost {
  background: transparent;
  border: 1px solid var(--app-divider);
  color: var(--app-muted);
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

.empty-state {
  padding: 18px;
  border: 1px dashed var(--app-divider);
  border-radius: var(--radius-large);
  color: var(--app-muted);
  text-align: center;
  margin: 8px 0;
}
.empty-state p {
  margin: 0;
}

.profiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 14px;
  margin-top: 16px;
}
.profile-card {
  background: var(--app-surface);
  border: 1px solid var(--app-surface-border);
  border-radius: var(--radius-large);
  box-shadow: var(--app-shadow);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.profile-card:hover {
  border-color: var(--app-muted);
}
.profile-card.active {
  border-color: var(--app-purple);
  box-shadow: 0 0 0 2px rgba(102, 82, 237, 0.18), var(--app-shadow);
}
.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.card-name {
  font-weight: 650;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-actions {
  display: flex;
  gap: 4px;
  flex-direction: row;
}
.card-bottom {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pill-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 9px;
  border: 1px solid var(--app-divider);
  border-radius: 10px;
  color: var(--app-muted);
  font-size: 11px;
}
.pill-badge.active-badge {
  color: var(--app-purple);
  border-color: var(--app-purple);
}
.card-time {
  margin-left: auto;
  color: var(--app-muted);
  font-size: 11px;
}

.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10;
}
.card-menu {
  position: fixed;
  z-index: 11;
  display: flex;
  flex-direction: column;
  min-width: 120px;
  background: var(--app-surface-solid);
  border: 1px solid var(--app-divider);
  border-radius: 10px;
  box-shadow: var(--app-shadow);
  padding: 6px;
}
.card-menu button {
  border: 0;
  background: transparent;
  border-radius: 7px;
  padding: 8px 10px;
  text-align: left;
  color: var(--app-text);
  font-size: 13px;
}
.card-menu button:hover {
  background: rgba(127, 127, 127, 0.1);
}
.card-menu button.danger {
  color: #e05b5b;
}

.resource-section {
  margin-top: 36px;
  background: var(--app-surface);
  border: 1px solid var(--app-surface-border);
  border-radius: var(--radius-large);
  box-shadow: var(--app-shadow);
  padding: 18px;
}
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.section-heading h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}
.section-sub {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 12px;
}
.update-all-button {
  height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--app-purple);
  color: #fff;
  font-weight: 600;
  flex: 0 0 auto;
}
.update-all-button:disabled {
  opacity: 0.5;
}
.batch-result {
  margin: 0 0 8px;
  color: var(--app-green);
  font-size: 12px;
}
.empty-note {
  margin: 8px 0 0;
  color: var(--app-muted);
  font-size: 12px;
}
.resource-group {
  margin-top: 12px;
}
.resource-group-title {
  margin: 14px 0 8px;
  font-size: 13px;
  font-weight: 650;
  color: var(--app-muted);
}
.resource-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.resource-row {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--app-surface-solid);
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  padding: 10px 12px;
}
.resource-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.resource-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resource-meta {
  color: var(--app-muted);
  font-size: 11px;
}
.resource-error {
  color: #e05b5b;
  font-size: 11px;
}
.resource-refresh {
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--app-text);
  padding: 6px 12px;
  flex: 0 0 auto;
}
.resource-refresh:disabled {
  opacity: 0.5;
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
