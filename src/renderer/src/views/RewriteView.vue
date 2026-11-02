<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useMitmStore } from '../stores/mitm'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import type { MitmModuleInfo } from '@shared/mitm'

const store = useMitmStore()
const toast = useToast()
const moduleUrl = ref('')
const localText = ref('')
const localBaseline = ref('')
const removing = ref<MitmModuleInfo | null>(null)
const expanded = ref<string | null>(null)

const state = computed(() => store.state)
const localDirty = computed(() => store.loaded && localText.value !== localBaseline.value)
useUnsavedChanges('rewrite-local-module', '本地重写规则', localDirty)

const summaryItems = computed(() => [
  { label: 'URL 重写', value: state.value.summary.urlRewrites },
  { label: '请求头/响应头', value: state.value.summary.headerRewrites },
  { label: '正文改写', value: state.value.summary.bodyRewrites },
  { label: '本地映射', value: state.value.summary.mapLocals },
  { label: '解密主机名', value: state.value.summary.hostnames.length }
])

const LOCAL_PLACEHOLDER = `# Surge 模块语法
[MITM]
hostname = %APPEND% api.example.com

[URL Rewrite]
^https?://ad\\.example\\.com - reject
^https?://old\\.example\\.com/(.*) https://new.example.com/$1 302

[Header Rewrite]
http-request ^https://api\\.example\\.com header-del Cookie

[Body Rewrite]
http-response ^https://api\\.example\\.com/user "\\"vip\\":false" "\\"vip\\":true"

[Map Local]
^https://api\\.example\\.com/ads data-type=json data="{}"`

function syncLocal(): void {
  localText.value = state.value.settings.localModule
  localBaseline.value = state.value.settings.localModule
}

watch(() => state.value.settings.localModule, () => { if (!localDirty.value) syncLocal() })

function formatDate(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : '—'
}

async function toggleRewrite(): Promise<void> {
  const next = !state.value.settings.rewriteEnabled
  const error = await store.setRewriteEnabled(next)
  if (error) toast.error('切换失败', error)
}

async function addModule(): Promise<void> {
  const url = moduleUrl.value.trim()
  if (!url) return
  const error = await store.addModule(url)
  if (error) toast.error('添加模块失败', error)
  else {
    moduleUrl.value = ''
    toast.success('模块已添加')
  }
}

async function updateModule(module: MitmModuleInfo): Promise<void> {
  const error = await store.updateModule(module.id)
  if (error) toast.error('更新失败', error)
  else toast.success(`${module.name} 已更新`)
}

async function toggleModule(module: MitmModuleInfo): Promise<void> {
  const error = await store.setModuleEnabled(module.id, !module.enabled)
  if (error) toast.error('切换失败', error)
}

async function confirmRemove(): Promise<void> {
  const target = removing.value
  removing.value = null
  if (!target) return
  const error = await store.removeModule(target.id)
  if (error) toast.error('删除失败', error)
}

async function saveLocal(): Promise<void> {
  const error = await store.setLocalModule(localText.value)
  if (error) toast.error('保存失败', error)
  else {
    syncLocal()
    toast.success('本地规则已保存')
  }
}

onMounted(async () => {
  await store.refresh()
  syncLocal()
})
</script>

<template>
  <div class="page-shell feature-page rewrite-view">
    <header class="feature-header">
      <div>
        <h1>重写</h1>
        <p>按 Surge 模块语法重定向、拒绝或修改 HTTP 请求与响应。HTTPS 请求需要先在「解密」页开启解密。</p>
      </div>
      <AppIcon name="rewrite" :size="25" />
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <section>
      <h2>重写</h2>
      <SurfaceCard class="rewrite-card">
        <div class="setting-head">
          <div>
            <h3>启用重写</h3>
            <p>关闭后只保留解密，所有重写规则都不执行。<RouterLink v-if="!state.active" to="/mitm" class="rewrite-link">解密未生效：{{ state.inactiveReason }}</RouterLink></p>
          </div>
          <button type="button" class="switch" :class="{ on: state.settings.rewriteEnabled }" role="switch" :aria-checked="state.settings.rewriteEnabled" aria-label="启用重写" :disabled="!!store.busy" @click="toggleRewrite" />
        </div>
        <div class="rewrite-summary">
          <div v-for="item in summaryItems" :key="item.label"><strong>{{ item.value }}</strong><span>{{ item.label }}</span></div>
        </div>
      </SurfaceCard>
    </section>

    <section>
      <h2>模块</h2>
      <SurfaceCard class="rewrite-card">
        <form class="rewrite-add" @submit.prevent="addModule">
          <input v-model="moduleUrl" type="url" placeholder="模块链接（.sgmodule）" aria-label="模块链接" spellcheck="false" />
          <button type="submit" class="rewrite-primary" :disabled="!!store.busy || !moduleUrl.trim()">{{ store.busy === 'add-module' ? '下载中…' : '添加' }}</button>
        </form>
        <p v-if="!state.modules.length" class="rewrite-hint">还没有模块。可以粘贴 Surge 模块链接，模块里的 [MITM] 主机名会自动加入解密列表。</p>
        <ul v-else class="rewrite-modules">
          <li v-for="module in state.modules" :key="module.id">
            <div class="rewrite-module-row">
              <div class="rewrite-module-text">
                <strong>{{ module.name }}</strong>
                <small v-if="module.description">{{ module.description }}</small>
                <small>{{ module.ruleCount }} 条规则 · {{ module.hostnames.length }} 个主机名 · 更新于 {{ formatDate(module.updatedAt) }}</small>
                <small v-if="module.error" class="rewrite-error">上次更新失败：{{ module.error }}</small>
                <button v-if="module.warnings.length" type="button" class="rewrite-link" @click="expanded = expanded === module.id ? null : module.id">{{ module.warnings.length }} 条未生效的内容</button>
              </div>
              <div class="rewrite-module-actions">
                <button v-if="module.url" type="button" class="rewrite-secondary" :disabled="!!store.busy" @click="updateModule(module)">{{ store.busy === `update-${module.id}` ? '更新中…' : '更新' }}</button>
                <button type="button" class="rewrite-danger" :disabled="!!store.busy" @click="removing = module">删除</button>
                <button type="button" class="switch" :class="{ on: module.enabled }" role="switch" :aria-checked="module.enabled" :aria-label="`启用 ${module.name}`" :disabled="!!store.busy" @click="toggleModule(module)" />
              </div>
            </div>
            <ul v-if="expanded === module.id" class="rewrite-warnings">
              <li v-for="warning in module.warnings" :key="warning">{{ warning }}</li>
            </ul>
          </li>
        </ul>
      </SurfaceCard>
    </section>

    <section>
      <h2>本地规则</h2>
      <SurfaceCard class="rewrite-card">
        <p class="rewrite-hint">支持 [MITM]、[URL Rewrite]、[Header Rewrite]、[Body Rewrite]、[Map Local]。脚本（[Script]）暂不支持。</p>
        <textarea v-model="localText" class="rewrite-editor" spellcheck="false" :placeholder="LOCAL_PLACEHOLDER" />
        <ul v-if="state.localWarnings.length" class="rewrite-warnings">
          <li v-for="warning in state.localWarnings" :key="warning">{{ warning }}</li>
        </ul>
        <div class="rewrite-actions">
          <span v-if="localDirty" class="unsaved-indicator">未保存</span>
          <button type="button" class="rewrite-secondary" :disabled="!localDirty" @click="syncLocal">撤销更改</button>
          <button type="button" class="rewrite-primary" :disabled="!!store.busy || !localDirty" @click="saveLocal">保存</button>
        </div>
      </SurfaceCard>
    </section>

    <ConfirmModal :open="!!removing" title="删除模块？" :description="`将删除「${removing?.name ?? ''}」及其规则。`" confirm-label="删除" :busy="!!store.busy" @close="removing = null" @confirm="confirmRemove" />
  </div>
</template>

<style scoped>
.rewrite-view section { margin-top: 24px; }
.rewrite-view h2 { margin: 0 0 11px; color: var(--app-pink); font-size: var(--font-size-md); font-weight: var(--font-weight-semibold); }
.rewrite-card { display: grid; gap: var(--space-4); padding: 14px 16px; border-radius: var(--radius-md); }
.rewrite-hint { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.rewrite-link { display: inline; margin-left: 6px; padding: 0; border: 0; background: transparent; color: var(--app-blue); font-size: inherit; text-decoration: none; cursor: pointer; }
.rewrite-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: var(--space-3); padding-top: 12px; border-top: 1px solid var(--app-divider); }
.rewrite-summary div { display: grid; gap: 2px; }
.rewrite-summary strong { font-size: var(--font-size-xl); font-weight: var(--font-weight-semibold); }
.rewrite-summary span { color: var(--app-muted); font-size: var(--font-size-2xs); }
.rewrite-add { display: flex; gap: var(--space-3); }
.rewrite-add input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
}
.rewrite-modules { margin: 0; padding: 0; list-style: none; }
.rewrite-modules > li { padding: 10px 0; border-top: 1px solid var(--app-divider); }
.rewrite-module-row { display: flex; align-items: center; gap: var(--space-4); }
.rewrite-module-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.rewrite-module-text strong { font-size: var(--font-size-md); }
.rewrite-module-text small { color: var(--app-muted); font-size: var(--font-size-2xs); overflow-wrap: anywhere; }
.rewrite-module-text .rewrite-link { justify-self: start; margin: 0; font-size: var(--font-size-2xs); }
.rewrite-module-actions { flex: none; display: flex; align-items: center; gap: var(--space-3); }
.rewrite-error { color: var(--app-danger) !important; }
.rewrite-warnings { margin: 6px 0 0; padding: 8px 10px 8px 26px; border-radius: var(--radius-control); background: var(--app-fill-subtle); color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.6; }
.rewrite-editor {
  width: 100%;
  min-height: 280px;
  padding: 10px 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.5;
  resize: vertical;
  white-space: pre;
}
.rewrite-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.rewrite-primary, .rewrite-secondary, .rewrite-danger {
  min-height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  cursor: pointer;
}
.rewrite-primary { background: var(--app-blue); color: var(--app-on-accent); }
.rewrite-secondary { background: var(--app-fill); color: inherit; }
.rewrite-danger { background: transparent; color: var(--app-danger); }
.rewrite-primary:disabled, .rewrite-secondary:disabled, .rewrite-danger:disabled { opacity: 0.55; cursor: default; }
</style>
