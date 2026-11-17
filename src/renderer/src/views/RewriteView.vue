<script setup lang="ts">
import { locale, t } from '@shared/i18n'
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import AppSelect from '../components/AppSelect.vue'
import { useMitmStore } from '../stores/mitm'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { useDialogFocus } from '../composables/use-dialog-focus'
import { moduleSection, moduleSections, replaceModuleSection, type MitmModuleInfo } from '@shared/mitm'

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
useUnsavedChanges('rewrite-local-module', t('rewrite.localRules'), localDirty)

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
      title: t('rewrite.urlTitle'),
      noun: t('rewrite.urlNoun'),
      description: t('rewrite.urlDesc'),
      count: summary.urlRewrites,
      example: '^https?://ad\\.example\\.com - reject\n^https?://old\\.example\\.com/(.*) https://new.example.com/$1 302'
    },
    {
      section: 'Header Rewrite',
      title: t('rewrite.headerTitle'),
      noun: t('rewrite.headerNoun'),
      description: t('rewrite.headerDesc'),
      count: summary.headerRewrites,
      example: 'http-request ^https://api\\.example\\.com header-del Cookie\nhttp-response ^https://api\\.example\\.com header-add X-Debug 1'
    },
    {
      section: 'Map Local',
      title: 'Mock',
      noun: ' Mock ',
      description: t('rewrite.mapLocalDesc'),
      count: summary.mapLocals,
      example: '^https://api\\.example\\.com/ads data-type=json data="{}"\n^https://api\\.example\\.com/empty data-type=text data="" status-code=204'
    },
    {
      section: 'Body Rewrite',
      title: t('rewrite.bodyTitle'),
      noun: t('rewrite.bodyNoun'),
      description: t('rewrite.bodyDesc'),
      count: summary.bodyRewrites,
      example: 'http-response ^https://api\\.example\\.com/user "\\"vip\\":false" "\\"vip\\":true"\nhttp-response-jq ^https://api\\.example\\.com/feed \'del(.ads)\''
    },
    {
      section: 'Script',
      title: t('common.script'),
      noun: t('rewrite.scriptNoun'),
      description: t('rewrite.scriptDesc'),
      count: summary.scripts,
      example: 'demo = type=http-response,pattern=^https://api\\.example\\.com/feed,requires-body=1,script-path=https://example.com/demo.js'
    },
    {
      section: 'Rule',
      title: t('rewrite.ruleTitle'),
      noun: t('rewrite.ruleNoun'),
      description: t('rewrite.ruleDesc'),
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
useUnsavedChanges('rewrite-section', t('rewrite.rewriteRules'), sectionDirty)
useDialogFocus(sectionOpen, sectionDialog, () => closeSection())
useDialogFocus(localOpen, localDialog, () => closeLocal())

// 模块小眼睛：抽屉里按段展示模块内容（与 Surge 的模块详情一致）。
const viewingModuleId = ref<string | null>(null)
const viewingModule = computed(() => state.value.modules.find((module) => module.id === viewingModuleId.value) ?? null)
const viewingModuleParts = computed(() => moduleSections(viewingModule.value?.content ?? ''))

// 「N 条规则生效中」→ 查看具体生效的规则（含模块来源）。
const viewingKind = ref<RuleKind | null>(null)
const viewDialog = ref<HTMLElement | null>(null)
const viewOpen = computed(() => !!viewingKind.value)
const viewingRules = computed(() => (viewingKind.value ? state.value.activeRules?.[viewingKind.value.section] ?? [] : []))
useDialogFocus(viewOpen, viewDialog, () => { viewingKind.value = null })

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
    toast.error(t('common.saveFailed'), error)
    return
  }
  syncLocal()
  editingKind.value = null
  toast.success(t('rewrite.kindSaved', [kind.title]))
}

const LOCAL_PLACEHOLDER = `# ${t('rewrite.sampleComment')}
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
  return ms ? new Date(ms).toLocaleString(locale.value) : '—'
}

async function toggleRewrite(): Promise<void> {
  const next = !state.value.settings.rewriteEnabled
  const error = await store.setRewriteEnabled(next)
  if (error) toast.error(t('common.switchFailed'), error)
}

async function addModule(): Promise<void> {
  const url = moduleUrl.value.trim()
  if (!url) return
  const error = await store.addModule(url)
  if (error) toast.error(t('rewrite.addModuleFailed'), error)
  else {
    moduleUrl.value = ''
    toast.success(t('rewrite.moduleAdded'))
  }
}

async function updateModule(module: MitmModuleInfo): Promise<void> {
  const error = await store.updateModule(module.id)
  if (error) toast.error(t('common.updateFailed'), error)
  else toast.success(t('rewrite.updatedName', [module.name]))
}

async function toggleModule(module: MitmModuleInfo): Promise<void> {
  const error = await store.setModuleEnabled(module.id, !module.enabled)
  if (error) toast.error(t('common.switchFailed'), error)
}

const editingArgsModule = computed(() => state.value.modules.find((module) => module.id === editingArgs.value) ?? null)

function openArguments(module: MitmModuleInfo): void {
  argDraft.value = Object.fromEntries(module.arguments.map((arg) => [arg.name, arg.value]))
  editingArgs.value = module.id
}

async function saveArguments(module: MitmModuleInfo): Promise<void> {
  const error = await store.setModuleArguments(module.id, { ...argDraft.value })
  if (error) toast.error(t('rewrite.argsSaveFailed'), error)
  else {
    editingArgs.value = null
    toast.success(t('rewrite.argsSaved'))
  }
}

function resetArguments(module: MitmModuleInfo): void {
  argDraft.value = Object.fromEntries(module.arguments.map((arg) => [arg.name, arg.default]))
}

async function clearStore(): Promise<void> {
  clearingStore.value = false
  const error = await store.clearScriptStore()
  if (error) toast.error(t('rewrite.clearFailed'), error)
  else toast.success(t('rewrite.scriptDataCleared'))
}

async function confirmRemove(): Promise<void> {
  const target = removing.value
  removing.value = null
  if (!target) return
  const error = await store.removeModule(target.id)
  if (error) toast.error(t('common.deleteFailed'), error)
}

async function saveLocal(): Promise<void> {
  const error = await store.setLocalModule(localText.value)
  if (error) toast.error(t('common.saveFailed'), error)
  else {
    syncLocal()
    localOpen.value = false
    toast.success(t('rewrite.localSaved'))
  }
}

// Modules can also be toggled from the tray menu: re-read when the window
// comes back to the foreground.
const refreshOnFocus = () => { void store.refresh() }

onMounted(async () => {
  window.addEventListener('focus', refreshOnFocus)
  await store.refresh()
  syncLocal()
})

onBeforeUnmount(() => window.removeEventListener('focus', refreshOnFocus))
</script>

<template>
  <div class="page-shell feature-page rewrite-view">
    <header class="surge-title">
      <div class="surge-title-row">
        <h1>{{ t('rewrite.title') }}</h1>
        <button type="button" class="switch surge-switch" :class="{ on: state.settings.rewriteEnabled }" role="switch" :aria-checked="state.settings.rewriteEnabled" :aria-label="t('rewrite.enableLabel')" :disabled="!!store.busy" @click="toggleRewrite" />
      </div>
      <p v-if="state.settings.rewriteEnabled && !state.active" class="surge-warn">{{ t('rewrite.needMitm', [state.inactiveReason]) }}<RouterLink to="/mitm" class="surge-link">{{ t('rewrite.goMitm') }}</RouterLink></p>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="rewrite-layout">
    <div class="rewrite-rules-column">
    <div class="rewrite-kinds" :class="{ off: !state.settings.rewriteEnabled }">
      <SurfaceCard v-for="kind in ruleKinds" :key="kind.section" class="rewrite-kind">
        <h3>{{ kind.title }}</h3>
        <p>{{ kind.description }}</p>
        <footer>
          <button type="button" class="rewrite-kind-count" :disabled="!kind.count" :aria-label="t('rewrite.viewKindLabel', [kind.count, kind.title])" @click="viewingKind = kind">{{ t('rewrite.activeCount', [kind.count]) }}<AppIcon v-if="kind.count" name="next" :size="12" /></button>
          <button type="button" class="rewrite-kind-edit" :disabled="!!store.busy" @click="openSection(kind)">{{ t('rewrite.editKind', [kind.noun]) }}</button>
        </footer>
      </SurfaceCard>
    </div>
    <p class="surge-hint rewrite-kinds-note">{{ t('rewrite.countNote') }}<button type="button" class="surge-link" @click="openLocal">{{ t('rewrite.editAllLocal') }}</button></p>
    </div>

    <section class="surge-section rewrite-modules-section">
      <h2 class="tone-pink">{{ t('resources.modules') }}</h2>
      <SurfaceCard class="rewrite-card">
        <form class="rewrite-add" @submit.prevent="addModule">
          <input v-model="moduleUrl" type="url" :placeholder="t('rewrite.moduleUrlPlaceholder')" :aria-label="t('rewrite.moduleUrlLabel')" spellcheck="false" />
          <button type="submit" class="rewrite-primary" :disabled="!!store.busy || !moduleUrl.trim()">{{ store.busy === 'add-module' ? t('rewrite.downloading') : t('common.addAction') }}</button>
        </form>
        <p v-if="!state.modules.length" class="rewrite-hint">{{ t('rewrite.noModules') }}</p>
        <ul v-else class="rewrite-modules">
          <li v-for="module in state.modules" :key="module.id">
            <div class="rewrite-module-row">
              <div class="rewrite-module-text">
                <strong>{{ module.name }}</strong>
                <small v-if="module.description">{{ module.description }}</small>
                <small>{{ t('resources.ruleCount', [module.ruleCount]) }}<template v-if="module.scripts">{{ t('rewrite.scriptCount', [module.scripts]) }}</template> {{ t('rewrite.moduleMeta', [module.hostnames.length, formatDate(module.updatedAt)]) }}</small>
                <small v-if="module.error" class="rewrite-error">{{ t('rewrite.lastUpdateFailed', [module.error]) }}</small>
                <span class="rewrite-module-links">
                  <button v-if="module.warnings.length" type="button" class="rewrite-link" @click="expanded = expanded === module.id ? null : module.id">{{ t('rewrite.skippedCount', [module.warnings.length]) }}</button>
                </span>
              </div>
              <div class="rewrite-module-actions">
                <button type="button" class="icon-control rewrite-module-view" :aria-label="t('rewrite.viewName', [module.name])" :title="t('rewrite.viewModule')" @click="viewingModuleId = module.id"><AppIcon name="eye" :size="16" /></button>
                <button v-if="module.arguments.length" type="button" class="rewrite-secondary" :disabled="!!store.busy" @click="openArguments(module)">{{ t('rewrite.editArgs') }}</button>
                <button v-if="module.url" type="button" class="rewrite-secondary" :disabled="!!store.busy" @click="updateModule(module)">{{ store.busy === `update-${module.id}` ? t('common.updating') : t('common.update') }}</button>
                <button type="button" class="rewrite-danger" :disabled="!!store.busy" @click="removing = module">{{ t('common.delete') }}</button>
                <button type="button" class="switch" :class="{ on: module.enabled }" role="switch" :aria-checked="module.enabled" :aria-label="t('localRules.enable', [module.name])" :disabled="!!store.busy" @click="toggleModule(module)" />
              </div>
            </div>
            <ul v-if="expanded === module.id" class="rewrite-warnings">
              <li v-for="warning in module.warnings" :key="warning">{{ warning }}</li>
            </ul>
          </li>
        </ul>
        <div v-if="state.summary.scriptStoreKeys" class="rewrite-store">
          <span>{{ t('rewrite.storeCount', [state.summary.scriptStoreKeys]) }}</span>
          <button type="button" class="rewrite-danger" :disabled="!!store.busy" @click="clearingStore = true">{{ t('dnsTools.flush') }}</button>
        </div>
      </SurfaceCard>
    </section>
    </div>

    <Teleport to="body">
      <div v-if="editingKind" class="modal-shade" role="presentation" @click.self="closeSection">
        <section ref="sectionDialog" class="rewrite-section-modal" role="dialog" aria-modal="true" :aria-label="t('rewrite.editKindLabel', [editingKind.title])">
          <header>
            <div>
              <h2>{{ editingKind.title }}</h2>
              <p>{{ t('rewrite.sectionHint', [editingKind.section]) }}</p>
            </div>
            <button type="button" class="icon-control" :aria-label="t('common.close')" :disabled="!!store.busy" @click="closeSection"><AppIcon name="close" /></button>
          </header>
          <textarea v-model="sectionText" class="rewrite-editor" spellcheck="false" :placeholder="editingKind.example" />
          <footer>
            <span v-if="sectionDirty" class="unsaved-indicator">{{ t('common.unsaved') }}</span>
            <button type="button" class="surge-button" :disabled="!!store.busy" @click="closeSection">{{ t('common.cancel') }}</button>
            <button type="button" class="surge-button primary" :disabled="!!store.busy || !sectionDirty" @click="saveSection">{{ store.busy === 'local-module' ? t('common.saving') : t('common.save') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="viewingKind" class="modal-shade" role="presentation" @click.self="viewingKind = null">
        <section ref="viewDialog" class="rewrite-section-modal" role="dialog" aria-modal="true" :aria-label="t('rewrite.activeKindLabel', [viewingKind.title])">
          <header>
            <div>
              <h2>{{ t('rewrite.activeSummary', [viewingKind.title, viewingRules.length]) }}</h2>
              <p>{{ t('rewrite.activeNote') }}</p>
            </div>
            <button type="button" class="icon-control" :aria-label="t('common.close')" @click="viewingKind = null"><AppIcon name="close" /></button>
          </header>
          <ol v-if="viewingRules.length" class="rewrite-active-list">
            <li v-for="(rule, index) in viewingRules" :key="index"><code>{{ rule.text }}</code><span>{{ rule.source }}</span></li>
          </ol>
          <p v-else class="rewrite-hint">{{ t('rewrite.noActive') }}</p>
          <footer>
            <button type="button" class="surge-button" @click="viewingKind = null">{{ t('common.close') }}</button>
            <button type="button" class="surge-button primary" @click="openSection(viewingKind); viewingKind = null">{{ t('rewrite.editLocal') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="localOpen" class="modal-shade" role="presentation" @click.self="closeLocal">
        <section ref="localDialog" class="rewrite-section-modal" role="dialog" aria-modal="true" :aria-label="t('rewrite.allLocal')">
          <header>
            <div>
              <h2>{{ t('rewrite.allLocal') }}</h2>
              <p>{{ t('rewrite.syntaxHint') }}</p>
            </div>
            <button type="button" class="icon-control" :aria-label="t('common.close')" :disabled="!!store.busy" @click="closeLocal"><AppIcon name="close" /></button>
          </header>
          <textarea v-model="localText" class="rewrite-editor" spellcheck="false" :placeholder="LOCAL_PLACEHOLDER" />
          <ul v-if="state.localWarnings.length" class="rewrite-warnings">
            <li v-for="warning in state.localWarnings" :key="warning">{{ warning }}</li>
          </ul>
          <footer>
            <span v-if="localDirty" class="unsaved-indicator">{{ t('common.unsaved') }}</span>
            <button type="button" class="surge-button" :disabled="!!store.busy" @click="closeLocal">{{ t('common.cancel') }}</button>
            <button type="button" class="surge-button primary" :disabled="!!store.busy || !localDirty" @click="saveLocal">{{ store.busy === 'local-module' ? t('common.saving') : t('common.save') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
    <DetailDrawer :open="!!editingArgsModule" :title="editingArgsModule?.name ?? ''" :subtitle="t('rewrite.argsSubtitle')" @close="editingArgs = null">
      <form v-if="editingArgsModule" class="module-args" @submit.prevent="saveArguments(editingArgsModule)">
        <div class="module-viewer-card module-args-card">
          <label v-for="arg in editingArgsModule.arguments" :key="arg.name" :title="arg.desc || undefined">
            <span><b>{{ arg.name }}</b><small v-if="arg.tag">{{ arg.tag }}</small></span>
            <button v-if="arg.kind === 'switch'" type="button" class="switch" :class="{ on: argDraft[arg.name] === 'true' }" role="switch" :aria-checked="argDraft[arg.name] === 'true'" :aria-label="arg.name" @click="argDraft[arg.name] = argDraft[arg.name] === 'true' ? 'false' : 'true'" />
            <AppSelect v-else-if="arg.kind === 'select' && arg.options?.length" :model-value="argDraft[arg.name] ?? arg.default" :options="arg.options.map((option) => ({ value: option, label: option }))" :label="arg.name" plain class="module-args-select" @update:model-value="(value: string) => (argDraft[arg.name] = value)" />
            <input v-else v-model="argDraft[arg.name]" type="text" spellcheck="false" :placeholder="arg.default" />
          </label>
        </div>
        <p v-if="editingArgsModule.argumentsDesc" class="module-args-desc">{{ editingArgsModule.argumentsDesc }}</p>
        <div class="rewrite-actions">
          <button type="button" class="rewrite-secondary" @click="resetArguments(editingArgsModule)">{{ t('common.restoreDefaults') }}</button>
          <button type="submit" class="rewrite-primary" :disabled="!!store.busy">{{ store.busy === `arguments-${editingArgsModule.id}` ? t('common.saving') : t('rewrite.saveArgs') }}</button>
        </div>
      </form>
    </DetailDrawer>
    <DetailDrawer :open="!!viewingModule" :title="viewingModule?.name ?? ''" :subtitle="t('rewrite.contentSubtitle')" @close="viewingModuleId = null">
      <div v-if="viewingModule" class="module-viewer">
        <dl class="module-viewer-card">
          <div><dt>{{ t('rewrite.moduleName') }}</dt><dd>{{ viewingModule.name }}</dd></div>
          <div v-if="viewingModule.description || viewingModuleParts.meta.desc"><dt>{{ t('rewrite.moduleDesc') }}</dt><dd>{{ viewingModule.description || viewingModuleParts.meta.desc }}</dd></div>
          <div v-if="viewingModule.url"><dt>URL</dt><dd class="module-viewer-url">{{ viewingModule.url }}</dd></div>
        </dl>
        <section v-for="section in viewingModuleParts.sections" :key="section.name" class="module-viewer-section">
          <h3>{{ section.name }}</h3>
          <pre :class="{ mitm: section.name.toLowerCase() === 'mitm' }">{{ section.body }}</pre>
        </section>
        <p v-if="!viewingModuleParts.sections.length" class="rewrite-hint">{{ t('rewrite.moduleEmpty') }}</p>
      </div>
    </DetailDrawer>
    <ConfirmModal :open="clearingStore" :title="t('rewrite.clearDataTitle')" :description="t('rewrite.clearDataDescription')" :confirm-label="t('dnsTools.flush')" :busy="!!store.busy" @close="clearingStore = false" @confirm="clearStore" />
    <ConfirmModal :open="!!removing" :title="t('rewrite.deleteModuleTitle')" :description="t('rewrite.deleteModuleDescription', [removing?.name ?? ''])" :confirm-label="t('common.delete')" :busy="!!store.busy" @close="removing = null" @confirm="confirmRemove" />
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
.module-viewer { display: grid; gap: 18px; }
.module-args { display: grid; gap: 14px; }
.module-args-card label { display: grid; grid-template-columns: minmax(90px, 42%) 1fr; align-items: center; gap: 12px; padding: 9px 0; border-top: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.module-args-card label:first-child { border-top: 0; }
.module-args-card label > span { display: grid; min-width: 0; }
.module-args-card label > span b { overflow: hidden; font-weight: var(--font-weight-regular); text-overflow: ellipsis; white-space: nowrap; }
.module-args-card label > span small { overflow: hidden; color: var(--app-muted); font-size: var(--font-size-2xs); text-overflow: ellipsis; white-space: nowrap; }
.module-args-card .switch { justify-self: end; }
.module-args-card .module-args-select { justify-self: end; width: max-content; max-width: 100%; }
.module-args-card .module-args-select :deep(.app-select-trigger) { font-size: var(--font-size-sm); font-weight: var(--font-weight-regular); color: var(--app-muted); }
.module-args-card input { min-width: 0; height: 28px; padding: 0; border: 0; background: transparent; color: var(--app-muted); font-size: var(--font-size-sm); text-align: right; }
.module-args-card input:focus { outline: none; color: var(--app-text); }
.module-args-card label:focus-within { box-shadow: inset 0 -2px 0 var(--app-blue); }
.module-args-desc { margin: 0 4px; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.module-viewer-card { display: grid; margin: 0; padding: 0 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); }
.module-viewer-card > div { padding: 11px 0; border-top: 1px solid var(--app-divider); }
.module-viewer-card > div:first-child { border-top: 0; }
.module-viewer-card dt { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.module-viewer-card dd { margin: 4px 0 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; overflow-wrap: anywhere; user-select: text; }
.module-viewer-section h3 { margin: 0 0 7px 4px; color: var(--app-muted); font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.module-viewer-section pre { margin: 0; padding: 12px 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.module-viewer-section pre.mitm { color: var(--app-danger); }
.rewrite-kind-count { display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.rewrite-kind-count:hover:not(:disabled) { color: var(--app-blue); }
.rewrite-kind-count:disabled { cursor: default; }
.rewrite-kind-count svg { color: var(--app-muted); }
.rewrite-active-list { display: grid; gap: 0; max-height: min(52vh, 420px); margin: 0; padding: 0; overflow: auto; list-style: none; border: 1px solid var(--app-divider); border-radius: var(--radius-control); }
.rewrite-active-list li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 8px 10px; border-top: 1px solid var(--app-divider); }
.rewrite-active-list li:first-child { border-top: 0; }
.rewrite-active-list code { min-width: 0; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; user-select: text; }
.rewrite-active-list span { flex: 0 0 auto; max-width: 40%; overflow: hidden; color: var(--app-muted); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.rewrite-kind-edit { min-height: 22px; padding: 0 8px; overflow: hidden; border: 1px solid var(--app-divider); border-radius: 6px; color: inherit; background: var(--app-surface-solid); font-size: var(--font-size-sm); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.rewrite-kind-edit:hover:not(:disabled) { background: var(--app-fill); }
.rewrite-kind-edit:disabled { opacity: 0.55; cursor: default; }
.rewrite-kinds-note { margin-top: 12px; padding-left: 14px; }
.rewrite-kinds-note .surge-link { margin-left: 6px; }
.rewrite-modules-section { margin-top: 30px; }
/* 宽窗口：规则类型卡片在左、模块列表在右，两栏并排，不把六张卡片拉成横条。
   窄窗口保持原来的上下排列。按内容区宽度（容器查询）而不是窗口宽度切换。 */
.rewrite-view { container: rewrite-page / inline-size; }
@container rewrite-page (min-width: 1180px) {
  .rewrite-layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(400px, 1fr); column-gap: 28px; align-items: start; }
  .rewrite-layout > .rewrite-modules-section { margin-top: 32px; }
}
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
