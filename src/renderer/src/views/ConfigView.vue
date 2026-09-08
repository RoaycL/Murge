<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useProfilesStore } from '../stores/profiles'
import type { ValidationResult } from '@shared/profiles'
import AppIcon from '../components/AppIcon.vue'
import AppSelect from '../components/AppSelect.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useToast } from '../composables/use-toast'
import EmptyState from '../components/EmptyState.vue'

const profilesStore = useProfilesStore()
const toast = useToast()

const url = ref('')
const importName = ref('')
const document = ref('')
const localFile = ref<File | null>(null)
const localFileInput = ref<HTMLInputElement | null>(null)
const urlInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
/** Profile id with an in-flight subscription update (card ↻ spinner guard). */
const updatingId = ref<string | null>(null)
const validation = ref<ValidationResult | null>(null)
const showAddDialog = ref(false)
const importSource = ref<'url' | 'file' | 'manual'>('url')
const selectedProfileId = ref<string | null>(null)
const pendingDeleteId = ref<string | null>(null)
const pendingRenameId = ref<string | null>(null)
const renameValue = ref('')
const editingId = ref<string | null>(null)
const editingDocument = ref('')
const editingUrl = ref('')
const savingEdit = ref(false)

const menuAnchor = ref<{ id: string; top: number; left: number } | null>(null)

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
  // Garbage/missing timestamps (epoch-0 or a wildly negative value from a
  // seconds-vs-ms mixup) would render as e.g. "2055 年前". Treat them as absent.
  if (Number.isNaN(ms) || ms <= 0) return '—'
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
  if (importing.value || !url.value.trim()) return
  importing.value = true
  try {
    // An empty name lets the main process derive one from the subscription
    // itself (Content-Disposition filename, then URL host). NEVER the raw URL:
    // its path can carry a token and would render as an overlong profile name.
    await profilesStore.importFromUrl(importName.value.trim(), url.value.trim(), false)
    showAddDialog.value = false
    toast.success('远程配置已添加', '选中该配置后才会启用')
  } catch {
    toast.error('远程配置导入失败', profilesStore.lastError ?? undefined)
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
  if (importing.value || !file) return
  importing.value = true
  try {
    const raw = await file.text()
    const fallbackName = file.name.replace(/\.(?:ya?ml)$/i, '') || file.name
    await profilesStore.importProfile({
      name: importName.value.trim() || fallbackName,
      document: raw,
      source: { type: 'file', path: file.name },
      activate: false
    })
    localFile.value = null
    if (localFileInput.value) localFileInput.value.value = ''
    showAddDialog.value = false
    toast.success('本地配置已添加', '选中该配置后才会启用')
  } catch {
    toast.error('本地配置导入失败', profilesStore.lastError ?? undefined)
  } finally {
    importing.value = false
  }
}

async function importManual(): Promise<void> {
  if (importing.value || !document.value.trim()) return
  importing.value = true
  try {
    await profilesStore.importProfile({
      name: importName.value.trim() || '手动配置',
      document: document.value,
      source: { type: 'manual' },
      activate: false
    })
    document.value = ''
    validation.value = null
    showAddDialog.value = false
    toast.success('手动配置已添加', '选中该配置后才会启用')
  } catch {
    toast.error('手动配置导入失败', profilesStore.lastError ?? undefined)
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
    toast.success('配置已启用')
  } catch {
    toast.error('无法启用配置', profilesStore.lastError ?? undefined)
  }
}

/**
 * Card ↻ semantics depend on the source: a URL-backed profile is RE-FETCHED
 * from its subscription (更新), and the main process automatically reapplies
 * the fresh document when that profile is the live one. File/manual profiles
 * have nothing to re-fetch, so the button falls back to re-applying (启用).
 */
async function cardRefresh(id: string): Promise<void> {
  closeMenu()
  const meta = profilesStore.profiles.find((entry) => entry.id === id)
  if (!meta || meta.source.type !== 'url') {
    await activate(id)
    return
  }
  if (updatingId.value === id) return
  updatingId.value = id
  try {
    await profilesStore.updateFromSource(id)
    toast.success(
      '配置已更新',
      meta.active ? '运行中的配置已自动重新加载' : '已保存到配置库，未改变当前运行配置'
    )
  } catch {
    toast.error('配置更新失败', profilesStore.lastError ?? undefined)
  } finally {
    updatingId.value = null
  }
}

async function remove(id: string): Promise<boolean> {
  try {
    await profilesStore.remove(id)
    return true
  } catch {
    toast.error('无法删除配置', profilesStore.lastError ?? undefined)
    return false
  } finally {
    closeMenu()
  }
}

async function confirmRemove(): Promise<void> {
  const id = pendingDeleteId.value
  if (!id) return
  if (!await remove(id)) return
  if (selectedProfileId.value === id) selectedProfileId.value = null
  pendingDeleteId.value = null
  toast.success('配置已删除')
}

function openRename(id: string): void {
  const meta = profilesStore.profiles.find((entry) => entry.id === id)
  if (!meta) return
  pendingRenameId.value = id
  renameValue.value = meta.name
  closeMenu()
}

async function confirmRename(): Promise<void> {
  const id = pendingRenameId.value
  const name = renameValue.value.trim()
  if (!id || !name) return
  try {
    await profilesStore.rename(id, name)
    pendingRenameId.value = null
    toast.success('配置已重命名')
  } catch {
    toast.error('无法重命名配置', profilesStore.lastError ?? undefined)
  }
}

async function openEditor(id: string): Promise<void> {
  closeMenu()
  const profile = await profilesStore.get(id)
  if (!profile) return
  editingId.value = id
  editingDocument.value = profile.document
  editingUrl.value = profile.meta.source.type === 'url' ? (await profilesStore.getSourceUrl(id) ?? '') : ''
}

async function saveEditor(): Promise<void> {
  const id = editingId.value
  if (!id) return
  const result = await profilesStore.validate(editingDocument.value)
  if (!result.ok) { toast.error('配置校验失败', result.issues.map((i) => i.message).join('；')); return }
  savingEdit.value = true
  try {
    const meta = profilesStore.profiles.find((item) => item.id === id)
    if (meta?.source.type === 'url' && editingUrl.value.trim()) await profilesStore.setSourceUrl(id, editingUrl.value.trim())
    await profilesStore.replaceDocument(id, editingDocument.value)
    editingId.value = null
    toast.success('配置已保存', meta?.active ? '运行中的配置已重新加载' : undefined)
  } catch { toast.error('配置保存失败', profilesStore.lastError ?? undefined) }
  finally { savingEdit.value = false }
}

onMounted(() => {
  void profilesStore.load()
})

const selectedProfile = computed(() => profilesStore.profiles.find((entry) => entry.id === selectedProfileId.value) ?? null)
</script>

<template>
  <div class="page-shell config-view">
    <header class="config-header">
      <div><h1>配置</h1></div>
      <button type="button" class="primary-button add-profile-button" @click="showAddDialog = true"><AppIcon name="add-file" :size="16" />添加配置</button>
    </header>

    <p v-if="profilesStore.lastError" class="inline-error" role="alert">{{ profilesStore.lastError }}</p>

    <Teleport to="body">
      <div v-if="showAddDialog" class="modal-shade" @click.self="showAddDialog = false">
        <section class="profile-import-modal" role="dialog" aria-modal="true" aria-label="添加配置">
          <header><div><h2>添加配置</h2><p>导入后加入配置列表；在列表中选中后才会设为当前配置并加载到内核。</p></div><button type="button" class="icon-control" aria-label="关闭" @click="showAddDialog = false"><AppIcon name="close" /></button></header>
          <div class="profile-source-tabs" role="tablist"><button type="button" :class="{ selected: importSource === 'url' }" @click="importSource = 'url'"><AppIcon name="resources" :size="16" />远程 URL</button><button type="button" :class="{ selected: importSource === 'file' }" @click="importSource = 'file'"><AppIcon name="profiles" :size="16" />本地文件</button><button type="button" :class="{ selected: importSource === 'manual' }" @click="importSource = 'manual'"><AppIcon name="code" :size="16" />手动编辑</button></div>
          <label class="modal-field"><span>显示名称</span><input v-model="importName" class="field" aria-label="配置显示名称" placeholder="可选，留空时自动生成" /></label>
          <template v-if="importSource === 'url'"><label class="modal-field"><span>订阅地址</span><div class="field-with-action"><input ref="urlInput" v-model="url" class="field" aria-label="订阅地址" placeholder="https://example.com/subscription" @keyup.enter="importFromUrl" /><button type="button" class="icon-control" aria-label="粘贴订阅地址" @click="pasteUrl"><AppIcon name="clipboard" :size="16" /></button></div></label></template>
          <label v-else-if="importSource === 'file'" class="modal-field"><span>本地 mihomo 配置</span><input ref="localFileInput" class="field file-input" type="file" accept=".yaml,.yml,text/yaml,application/yaml" aria-label="本地 mihomo 配置文件" @change="selectLocalFile" /></label>
          <label v-else class="modal-field"><span>配置 YAML</span><textarea v-model="document" class="field document" aria-label="mihomo 配置 YAML" spellcheck="false" placeholder="粘贴 mihomo 配置 YAML…" /></label>
          <p v-if="validation && !validation.ok" class="inline-error" role="alert">{{ validation.issues.map((issue) => issue.message).join('；') }}</p><template v-else-if="validation?.ok"><p class="inline-ok">配置有效</p><ul v-if="validation.issues.length" class="validation-warnings"><li v-for="(issue, index) in validation.issues" :key="index">第 {{ issue.line ?? '—' }} 行：{{ issue.message }}</li></ul></template>
          <footer><button type="button" class="secondary-button" @click="showAddDialog = false">取消</button><button v-if="importSource === 'manual'" type="button" class="secondary-button" :disabled="!document.trim()" @click="previewValidation">校验</button><button type="button" class="primary-button" :disabled="importing || (importSource === 'url' ? !url.trim() : importSource === 'file' ? !localFile : !document.trim())" @click="importSource === 'url' ? importFromUrl() : importSource === 'file' ? importLocalFile() : importManual()">{{ importing ? '导入中…' : '验证并添加' }}</button></footer>
        </section>
      </div>
    </Teleport>

    <div v-if="profilesStore.status === 'loading' || profilesStore.status === 'idle'" class="empty-state">
      <p>正在加载配置…</p>
    </div>
    <EmptyState v-else-if="profilesStore.ordered.length === 0" icon="profiles" title="还没有配置文件" detail="添加远程订阅、本地 YAML，或手动创建一份 mihomo 配置。" action-label="添加配置" @action="showAddDialog = true" />
    <div v-else class="profiles-grid">
      <article
        v-for="meta in profilesStore.ordered"
        :key="meta.id"
        class="profile-card"
        :class="{ active: meta.active }"
        tabindex="0"
        role="button"
        :aria-label="`查看配置 ${meta.name}`"
        @click="selectedProfileId = meta.id"
        @keyup.enter="selectedProfileId = meta.id"
        @keyup.space.prevent="selectedProfileId = meta.id"
      >
        <div class="card-top">
          <span class="card-name" :style="{ color: cardColor(meta.id) }">{{ meta.name }}</span>
          <div class="card-actions">
            <button
              type="button"
              class="icon-button small"
              :aria-label="meta.source.type === 'url' ? '更新订阅配置' : '重新应用该配置'"
              :title="meta.source.type === 'url' ? '更新订阅配置' : '重新应用'"
              :disabled="updatingId === meta.id"
              @click.stop="cardRefresh(meta.id)"
            ><AppIcon name="refresh" :size="15" /></button>
            <button
              type="button"
              class="icon-button small"
              aria-label="更多操作"
              title="更多"
              @click.stop="toggleMenu(meta.id, $event)"
            ><AppIcon name="more-horizontal" :size="16" /></button>
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
          <button type="button" role="menuitem" @click="openEditor(meta.id)">编辑配置</button>
          <button type="button" role="menuitem" @click="openRename(meta.id)">重命名</button>
          <button type="button" role="menuitem" class="danger" @click="pendingDeleteId = meta.id; closeMenu()">删除</button>
        </template>
      </template>
    </div>

    <DetailDrawer :open="Boolean(selectedProfile)" :title="selectedProfile?.name ?? '配置详情'" :subtitle="selectedProfile ? `${sourceBadge(selectedProfile.source.type)} · ${relativeTime(selectedProfile.updatedAt)}` : ''" @close="selectedProfileId = null">
      <div v-if="selectedProfile" class="entity-detail drawer-detail"><dl><div><dt>来源</dt><dd>{{ sourceBadge(selectedProfile.source.type) }}</dd></div><div><dt>更新时间</dt><dd>{{ relativeTime(selectedProfile.updatedAt) }}</dd></div><div><dt>状态</dt><dd>{{ selectedProfile.active ? '使用中' : '未启用' }}</dd></div></dl></div>
      <template #footer><button type="button" class="secondary-button" @click="selectedProfile && openEditor(selectedProfile.id)"><AppIcon name="code" :size="15" />编辑配置</button><button type="button" class="danger-button" :disabled="selectedProfile?.active" @click="selectedProfile && (pendingDeleteId = selectedProfile.id)"><AppIcon name="delete" :size="15" />删除</button><button type="button" class="primary-button" :disabled="selectedProfile?.active" @click="selectedProfile && activate(selectedProfile.id)">{{ selectedProfile?.active ? '正在使用' : '使用此配置' }}</button></template>
    </DetailDrawer>
    <ConfirmModal :open="Boolean(pendingDeleteId)" title="删除此配置？" description="这会移除本地配置记录；当前正在使用的配置不能删除，远程订阅源不会受到影响。" @close="pendingDeleteId = null" @confirm="confirmRemove" />
    <Teleport to="body"><div v-if="pendingRenameId" class="modal-shade" @click.self="pendingRenameId = null"><section class="rename-modal" role="dialog" aria-modal="true" aria-label="重命名配置"><header><h2>重命名配置</h2><button type="button" class="icon-control" aria-label="关闭" @click="pendingRenameId = null"><AppIcon name="close" /></button></header><input v-model="renameValue" class="field" autofocus aria-label="配置名称" @keyup.enter="confirmRename" /><footer><button type="button" class="secondary-button" @click="pendingRenameId = null">取消</button><button type="button" class="primary-button" :disabled="!renameValue.trim()" @click="confirmRename">保存</button></footer></section></div></Teleport>
    <Teleport to="body"><div v-if="editingId" class="modal-shade" @click.self="editingId = null"><section class="profile-edit-modal" role="dialog" aria-modal="true" aria-label="编辑配置"><header><div><h2>编辑配置</h2><p>保存前会校验 YAML；正在使用的配置会自动重新加载。</p></div><button type="button" class="icon-control" aria-label="关闭" @click="editingId = null"><AppIcon name="close" /></button></header><label v-if="profilesStore.profiles.find(i => i.id === editingId)?.source.type === 'url'" class="modal-field"><span>订阅地址</span><input v-model="editingUrl" class="field" aria-label="订阅地址（完整）" /></label><label class="modal-field editor-field"><span>配置 YAML</span><textarea v-model="editingDocument" class="field document profile-document-editor" spellcheck="false" aria-label="编辑配置 YAML" /></label><footer><button type="button" class="secondary-button" @click="editingId = null">取消</button><button type="button" class="primary-button" :disabled="savingEdit || !editingDocument.trim()" @click="saveEditor">{{ savingEdit ? '保存中…' : '校验并保存' }}</button></footer></section></div></Teleport>

  </div>
</template>

<style scoped>
.config-view {
  display: flex;
  flex-direction: column;
}
.config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}
.add-profile-button { display: inline-flex; align-items: center; gap: 6px; }
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
.profile-import-modal { width: min(470px, calc(100vw - 48px)); padding: 20px; border: 1px solid var(--app-divider); border-radius: 16px; color: var(--app-text); background: var(--app-surface-solid); box-shadow: 0 22px 70px rgba(0,0,0,.28); }
.profile-import-modal header { display:flex; align-items:flex-start; justify-content:space-between; }
.profile-import-modal h2 { margin:0; font-size:19px; }.profile-import-modal header p{margin:4px 0 0;color:var(--app-muted);font-size:10px}
.profile-source-tabs { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin:18px 0; }
.profile-source-tabs button { display:flex; align-items:center; justify-content:center; gap:6px; height:34px; border:1px solid var(--app-divider); border-radius:8px; color:inherit; background:transparent; }
.profile-source-tabs button.selected { border-color:var(--app-purple); color:white; background:var(--app-purple); }
.modal-field { display:block; margin-top:12px; }.modal-field>span{display:block;margin-bottom:6px;color:var(--app-muted);font-size:10px}.modal-field .field{min-height:34px}
.field-with-action{display:grid;grid-template-columns:1fr 34px;gap:7px}.field-with-action .icon-control{width:34px;height:34px}
.profile-import-modal footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.rename-modal{width:min(380px,calc(100vw - 48px));padding:20px;border:1px solid var(--app-divider);border-radius:16px;color:var(--app-text);background:var(--app-surface-solid);box-shadow:0 22px 70px rgba(0,0,0,.28)}.rename-modal header,.rename-modal footer{display:flex;align-items:center;justify-content:space-between}.rename-modal h2{margin:0;font-size:19px}.rename-modal>.field{min-height:36px;margin-top:18px}.rename-modal footer{justify-content:flex-end;gap:8px;margin-top:18px}
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
  flex: 1 1 auto;
  min-width: 0;
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

.inline-error {
  color: #e05b5b;
  font-size: 12px;
}
.inline-ok {
  color: var(--app-green);
  font-size: 12px;
}
.validation-warnings {
  margin: 6px 0 0;
  padding-left: 18px;
  color: #b97800;
  font-size: 11px;
  line-height: 1.5;
}
</style>
