<script setup lang="ts">
import { computed, onMounted, ref, toRef, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useMitmStore } from '../stores/mitm'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { useDialogFocus } from '../composables/use-dialog-focus'
import { moduleSection, replaceModuleSection, type MitmModuleInfo } from '@shared/mitm'

const store = useMitmStore()
const toast = useToast()
const moduleUrl = ref('')
const localText = ref('')
const localBaseline = ref('')
const removing = ref<MitmModuleInfo | null>(null)
const expanded = ref<string | null>(null)
const editingArgs = ref<string | null>(null)
const argDraft = ref<Record<string, string>>({})
const clearingStore = ref(false)
const localOpen = ref(false)
const localDialog = ref<HTMLElement | null>(null)

const state = computed(() => store.state)
const localDirty = computed(() => store.loaded && localText.value !== localBaseline.value)
useUnsavedChanges('rewrite-local-module', '本地重写规则', localDirty)

interface RuleKind {
  section: string
  title: string
  noun: string
  description: string
  count: number
  example: string
}

const ruleKinds = computed<RuleKind[]>(() => {
  const summary = state.value.summary
  return [
    {
      section: 'URL Rewrite',
      title: 'URL 重定向',
      noun: ' URL 重定向',
      description: '重定向 HTTP 请求。此功能也称为 Map Remote。可以用跳转、直接改写和拒绝 3 种方法重写请求的 URL。',
      count: summary.urlRewrites,
      example: '^https?://ad\\.example\\.com - reject\n^https?://old\\.example\\.com/(.*) https://new.example.com/$1 302'
    },
    {
      section: 'Header Rewrite',
      title: 'Header 重写',
      noun: ' Header 重写',
      description: '可以修改发送到服务器的 HTTP Header，以及修改返回响应的 Header。',
      count: summary.headerRewrites,
      example: 'http-request ^https://api\\.example\\.com header-del Cookie\nhttp-response ^https://api\\.example\\.com header-add X-Debug 1'
    },
    {
      section: 'Map Local',
      title: 'Mock',
      noun: ' Mock ',
      description: '您可以模拟 API 服务器并返回静态响应。此功能也可称为 Map Local 或 API Mocking。如果你想动态返回响应，请使用脚本。',
      count: summary.mapLocals,
      example: '^https://api\\.example\\.com/ads data-type=json data="{}"\n^https://api\\.example\\.com/empty data-type=text data="" status-code=204'
    },
    {
      section: 'Body Rewrite',
      title: 'Body 重写',
      noun: ' Body 重写',
      description: '可以重写 HTTP 请求或响应的 Body，用正则表达式或 jq 替换原始内容。如果你需要进行更灵活的修改，请使用脚本。',
      count: summary.bodyRewrites,
      example: 'http-response ^https://api\\.example\\.com/user "\\"vip\\":false" "\\"vip\\":true"\nhttp-response-jq ^https://api\\.example\\.com/feed \'del(.ads)\''
    },
    {
      section: 'Script',
      title: '脚本',
      noun: '脚本',
      description: '使用 JavaScript 脚本处理 HTTP 请求与响应，兼容 Surge、Loon 和 Quantumult X 的脚本。',
      count: summary.scripts,
      example: 'demo = type=http-response,pattern=^https://api\\.example\\.com/feed,requires-body=1,script-path=https://example.com/demo.js'
    },
    {
      section: 'Rule',
      title: '分流规则',
      noun: '分流',
      description: '随模块一起生效的分流规则，只能使用 DIRECT 或 REJECT 策略，不需要解密。',
      count: summary.rules,
      example: 'DOMAIN-SUFFIX,ads.example.com,REJECT\nDOMAIN,api.example.com,DIRECT'
    }
  ]
})

const editingKind = ref<RuleKind | null>(null)
const sectionText = ref('')
const sectionBaseline = ref('')
const sectionDialog = ref<HTMLElement | null>(null)
const sectionOpen = computed(() => !!editingKind.value)
const sectionDirty = computed(() => sectionOpen.value && sectionText.value !== sectionBaseline.value)
useUnsavedChanges('rewrite-section', '重写规则', sectionDirty)
useDialogFocus(sectionOpen, sectionDialog, () => closeSection())
useDialogFocus(localOpen, localDialog, () => closeLocal())

function openLocal(): void {
  syncLocal()
  localOpen.value = true
}

function closeLocal(): void {
  if (store.busy) return
  syncLocal()
  localOpen.value = false
}

function openSection(kind: RuleKind): void {
  const text = moduleSection(localText.value, kind.section)
  sectionText.value = text
  sectionBaseline.value = text
  editingKind.value = kind
}

function closeSection(): void {
  if (store.busy) return
  editingKind.value = null
}

async function saveSection(): Promise<void> {
  const kind = editingKind.value
  if (!kind) return
  const next = replaceModuleSection(localText.value, kind.section, sectionText.value)
  const error = await store.setLocalModule(next)
  if (error) {
    toast.error('保存失败', error)
    return
  }
  syncLocal()
  editingKind.value = null
  toast.success(`${kind.title}规则已保存`)
}

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
http-response-jq ^https://api\\.example\\.com/feed 'del(.ads)'

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

function openArguments(module: MitmModuleInfo): void {
  if (editingArgs.value === module.id) {
    editingArgs.value = null
    return
  }
  argDraft.value = Object.fromEntries(module.arguments.map((arg) => [arg.name, arg.value]))
  editingArgs.value = module.id
}

async function saveArguments(module: MitmModuleInfo): Promise<void> {
  const error = await store.setModuleArguments(module.id, { ...argDraft.value })
  if (error) toast.error('保存参数失败', error)
  else {
    editingArgs.value = null
    toast.success('参数已保存')
  }
}

function resetArguments(module: MitmModuleInfo): void {
  argDraft.value = Object.fromEntries(module.arguments.map((arg) => [arg.name, arg.default]))
}

async function clearStore(): Promise<void> {
  clearingStore.value = false
  const error = await store.clearScriptStore()
  if (error) toast.error('清除失败', error)
  else toast.success('脚本数据已清除')
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
    localOpen.value = false
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
    <header class="surge-title">
      <div class="surge-title-row">
        <h1>重写 &amp; 映射</h1>
        <button type="button" class="switch surge-switch" :class="{ on: state.settings.rewriteEnabled }" role="switch" :aria-checked="state.settings.rewriteEnabled" aria-label="启用重写" :disabled="!!store.busy" @click="toggleRewrite" />
      </div>
      <p v-if="state.settings.rewriteEnabled && !state.active" class="surge-warn">HTTPS 请求需要先开启解密（{{ state.inactiveReason }}）。<RouterLink to="/mitm" class="surge-link">前往解密</RouterLink></p>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="rewrite-kinds" :class="{ off: !state.settings.rewriteEnabled }">
      <SurfaceCard v-for="kind in ruleKinds" :key="kind.section" class="rewrite-kind">
        <h3>{{ kind.title }}</h3>
        <p>{{ kind.description }}</p>
        <footer>
          <span>{{ kind.count }} 条规则生效中</span>
          <button type="button" class="rewrite-kind-edit" :disabled="!!store.busy" @click="openSection(kind)">编辑{{ kind.noun }}规则…</button>
        </footer>
      </SurfaceCard>
    </div>
    <p class="surge-hint rewrite-kinds-note">以上计数包含了模块中的规则。<button type="button" class="surge-link" @click="openLocal">编辑全部本地规则…</button></p>

    <section class="surge-section rewrite-modules-section">
      <h2 class="tone-pink">模块</h2>
      <SurfaceCard class="rewrite-card">
        <form class="rewrite-add" @submit.prevent="addModule">
          <input v-model="moduleUrl" type="url" placeholder="模块链接（.sgmodule / .plugin / .snippet）" aria-label="模块链接" spellcheck="false" />
          <button type="submit" class="rewrite-primary" :disabled="!!store.busy || !moduleUrl.trim()">{{ store.busy === 'add-module' ? '下载中…' : '添加' }}</button>
        </form>
        <p v-if="!state.modules.length" class="rewrite-hint">还没有模块。可以粘贴 Surge 模块、Loon 插件或 Quantumult X 重写链接，模块里的 MITM 主机名会自动加入解密列表。</p>
        <ul v-else class="rewrite-modules">
          <li v-for="module in state.modules" :key="module.id">
            <div class="rewrite-module-row">
              <div class="rewrite-module-text">
                <strong>{{ module.name }}</strong>
                <small v-if="module.description">{{ module.description }}</small>
                <small>{{ module.ruleCount }} 条规则<template v-if="module.scripts">（含 {{ module.scripts }} 个脚本）</template> · {{ module.hostnames.length }} 个主机名 · 更新于 {{ formatDate(module.updatedAt) }}</small>
                <small v-if="module.error" class="rewrite-error">上次更新失败：{{ module.error }}</small>
                <span class="rewrite-module-links">
                  <button v-if="module.arguments.length" type="button" class="rewrite-link" @click="openArguments(module)">{{ module.arguments.length }} 个参数</button>
                  <button v-if="module.warnings.length" type="button" class="rewrite-link" @click="expanded = expanded === module.id ? null : module.id">{{ module.warnings.length }} 条未生效的内容</button>
                </span>
              </div>
              <div class="rewrite-module-actions">
                <button v-if="module.url" type="button" class="rewrite-secondary" :disabled="!!store.busy" @click="updateModule(module)">{{ store.busy === `update-${module.id}` ? '更新中…' : '更新' }}</button>
                <button type="button" class="rewrite-danger" :disabled="!!store.busy" @click="removing = module">删除</button>
                <button type="button" class="switch" :class="{ on: module.enabled }" role="switch" :aria-checked="module.enabled" :aria-label="`启用 ${module.name}`" :disabled="!!store.busy" @click="toggleModule(module)" />
              </div>
            </div>
            <form v-if="editingArgs === module.id" class="rewrite-arguments" @submit.prevent="saveArguments(module)">
              <p v-if="module.argumentsDesc" class="rewrite-arguments-desc">{{ module.argumentsDesc }}</p>
              <label v-for="arg in module.arguments" :key="arg.name">
                <span>{{ arg.name }}</span>
                <input v-model="argDraft[arg.name]" type="text" spellcheck="false" :placeholder="arg.default" />
              </label>
              <div class="rewrite-actions">
                <button type="button" class="rewrite-secondary" @click="resetArguments(module)">恢复默认</button>
                <button type="submit" class="rewrite-primary" :disabled="!!store.busy">{{ store.busy === `arguments-${module.id}` ? '保存中…' : '保存参数' }}</button>
              </div>
            </form>
            <ul v-if="expanded === module.id" class="rewrite-warnings">
              <li v-for="warning in module.warnings" :key="warning">{{ warning }}</li>
            </ul>
          </li>
        </ul>
        <div v-if="state.summary.scriptStoreKeys" class="rewrite-store">
          <span>脚本保存了 {{ state.summary.scriptStoreKeys }} 项数据（$persistentStore）</span>
          <button type="button" class="rewrite-danger" :disabled="!!store.busy" @click="clearingStore = true">清除</button>
        </div>
      </SurfaceCard>
    </section>

    <Teleport to="body">
      <div v-if="editingKind" class="modal-shade" role="presentation" @click.self="closeSection">
        <section ref="sectionDialog" class="rewrite-section-modal" role="dialog" aria-modal="true" :aria-label="`编辑${editingKind.title}规则`">
          <header>
            <div>
              <h2>{{ editingKind.title }}</h2>
              <p>本地规则中的 [{{ editingKind.section }}] 段，每行一条。模块里的规则请在模块中修改。</p>
            </div>
            <button type="button" class="icon-control" aria-label="关闭" :disabled="!!store.busy" @click="closeSection"><AppIcon name="close" /></button>
          </header>
          <textarea v-model="sectionText" class="rewrite-editor" spellcheck="false" :placeholder="editingKind.example" />
          <footer>
            <span v-if="sectionDirty" class="unsaved-indicator">未保存</span>
            <button type="button" class="surge-button" :disabled="!!store.busy" @click="closeSection">取消</button>
            <button type="button" class="surge-button primary" :disabled="!!store.busy || !sectionDirty" @click="saveSection">{{ store.busy === 'local-module' ? '保存中…' : '保存' }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="localOpen" class="modal-shade" role="presentation" @click.self="closeLocal">
        <section ref="localDialog" class="rewrite-section-modal" role="dialog" aria-modal="true" aria-label="全部本地规则">
          <header>
            <div>
              <h2>全部本地规则</h2>
              <p>Surge 模块语法。支持 [URL Rewrite]、[Header Rewrite]、[Body Rewrite]（含 jq）、[Map Local]、[Script]、[Rule]、[MITM]，也能识别 Loon 的 [Rewrite] 和 Quantumult X 的 [rewrite_local]。[Rule] 只能使用 DIRECT 或 REJECT。</p>
            </div>
            <button type="button" class="icon-control" aria-label="关闭" :disabled="!!store.busy" @click="closeLocal"><AppIcon name="close" /></button>
          </header>
          <textarea v-model="localText" class="rewrite-editor" spellcheck="false" :placeholder="LOCAL_PLACEHOLDER" />
          <ul v-if="state.localWarnings.length" class="rewrite-warnings">
            <li v-for="warning in state.localWarnings" :key="warning">{{ warning }}</li>
          </ul>
          <footer>
            <span v-if="localDirty" class="unsaved-indicator">未保存</span>
            <button type="button" class="surge-button" :disabled="!!store.busy" @click="closeLocal">取消</button>
            <button type="button" class="surge-button primary" :disabled="!!store.busy || !localDirty" @click="saveLocal">{{ store.busy === 'local-module' ? '保存中…' : '保存' }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
    <ConfirmModal :open="clearingStore" title="清除脚本数据？" description="会删除所有脚本通过 $persistentStore 保存的数据，例如 BoxJs 的设置和各脚本的登录信息。" confirm-label="清除" :busy="!!store.busy" @close="clearingStore = false" @confirm="clearStore" />
    <ConfirmModal :open="!!removing" title="删除模块？" :description="`将删除「${removing?.name ?? ''}」及其规则。`" confirm-label="删除" :busy="!!store.busy" @close="removing = null" @confirm="confirmRemove" />
  </div>
</template>

<style scoped>
.rewrite-card { display: grid; gap: var(--space-4); padding: 14px 16px; border-radius: var(--radius-md); }
.rewrite-hint { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.rewrite-link { display: inline; margin-left: 6px; padding: 0; border: 0; background: transparent; color: var(--app-blue); font-size: inherit; text-decoration: none; cursor: pointer; }
.rewrite-kinds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin-top: 32px; transition: opacity 0.15s; }
.rewrite-kinds.off { opacity: 0.55; }
@media (max-width: 720px) { .rewrite-kinds { grid-template-columns: minmax(0, 1fr); } }
.rewrite-kind { display: flex; flex-direction: column; min-height: 132px; padding: 14px 16px 12px; border-radius: var(--radius-panel); }
.rewrite-kind h3 { margin: 0 0 7px; font-size: var(--font-size-md); font-weight: var(--font-weight-semibold); }
.rewrite-kind p { display: -webkit-box; flex: 1; margin: 0; overflow: hidden; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.rewrite-kind footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; font-size: var(--font-size-xs); font-weight: var(--font-weight-medium); }
.rewrite-kind-edit { min-height: 22px; padding: 0 8px; overflow: hidden; border: 1px solid var(--app-divider); border-radius: 6px; color: inherit; background: var(--app-surface-solid); font-size: var(--font-size-sm); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.rewrite-kind-edit:hover:not(:disabled) { background: var(--app-fill); }
.rewrite-kind-edit:disabled { opacity: 0.55; cursor: default; }
.rewrite-kinds-note { margin-top: 12px; padding-left: 14px; }
.rewrite-kinds-note .surge-link { margin-left: 6px; }
.rewrite-modules-section { margin-top: 30px; }
.rewrite-section-modal { display: grid; gap: 14px; width: min(680px, calc(100vw - 48px)); padding: 20px; border: 1px solid var(--app-divider); border-radius: var(--radius-panel); color: var(--app-text); background: var(--app-popover); -webkit-backdrop-filter: var(--app-popover-filter); backdrop-filter: var(--app-popover-filter); box-shadow: 0 22px 70px rgba(0, 0, 0, 0.28); }
.rewrite-section-modal header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.rewrite-section-modal h2 { margin: 0; font-size: var(--font-size-title); }
.rewrite-section-modal header p { margin: 6px 0 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.rewrite-section-modal footer { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.rewrite-section-modal .rewrite-editor { min-height: 300px; }
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
.rewrite-module-links { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.rewrite-module-text .rewrite-link { justify-self: start; margin: 0; font-size: var(--font-size-2xs); }
.rewrite-arguments { display: grid; gap: var(--space-3); margin-top: 8px; padding: 10px 12px; border-radius: var(--radius-control); background: var(--app-fill-subtle); }
.rewrite-arguments-desc { margin: 0; color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.5; white-space: pre-wrap; }
.rewrite-store { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding-top: 10px; border-top: 1px solid var(--app-divider); color: var(--app-muted); font-size: var(--font-size-xs); }
.rewrite-arguments label { display: grid; grid-template-columns: minmax(90px, 160px) 1fr; align-items: center; gap: var(--space-3); font-size: var(--font-size-xs); }
.rewrite-arguments label span { overflow: hidden; color: var(--app-muted); text-overflow: ellipsis; white-space: nowrap; }
.rewrite-arguments input { min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: var(--app-surface-solid); color: inherit; font-size: var(--font-size-sm); }
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
.rewrite-danger { background: color-mix(in srgb, var(--app-danger) 10%, transparent); color: var(--app-danger); }
.rewrite-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--app-danger) 16%, transparent); }
.rewrite-primary:disabled, .rewrite-secondary:disabled, .rewrite-danger:disabled { opacity: 0.55; cursor: default; }
</style>
