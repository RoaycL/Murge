<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useOverridesStore } from '../stores/overrides'
import type { OverrideInput } from '@shared/overrides'
import { diffLines } from '@shared/overrides'
import AppIcon from './AppIcon.vue'
import AppSelect from './AppSelect.vue'
import { useToast } from '../composables/use-toast'

const props = defineProps<{ activeProfileId: string | null }>()

const store = useOverridesStore()
const toast = useToast()

const editingId = ref<string | null>(null)
const editorOpen = ref(false)
const form = reactive<OverrideInput>({
  name: '',
  kind: 'yaml',
  scope: 'global',
  profileId: null,
  content: ''
})

const open = computed(() => editorOpen.value)
const isEditing = computed(() => editingId.value !== null)
const canUseProfileScope = computed(() => props.activeProfileId !== null)
const yamlPlaceholder = ['proxy-groups:', '  - name: auto', '    type: url-test'].join('\n')
const jsPlaceholder = ['function main(config) {', '  config.mode = "rule"', '  return config', '}'].join('\n')

const previewDiff = computed(() => {
  const preview = store.preview
  if (!preview || preview.unavailable) return []
  return diffLines(preview.baseText, preview.appliedText)
})
const hasLastKnownGood = computed(() => store.lastGood !== null)
const lastGoodLabel = computed(() => {
  const last = store.lastGood
  if (!last) return ''
  return `上次可用：${new Date(last.capturedAt).toLocaleString()}`
})

function issueSummary(): string {
  const validation = store.validation
  if (!validation || validation.valid) return ''
  return `${validation.issues.filter((issue) => issue.level === 'error').length} 项错误`
}

async function runPreview(): Promise<void> {
  await store.refreshPreview()
  void store.refreshLastKnownGood()
}

async function runValidation(): Promise<void> {
  await store.refreshValidation()
  void store.refreshLastKnownGood()
}

async function rollback(): Promise<void> {
  const ok = await store.resetToLastGood()
  if (ok) {
    await store.refresh()
    await store.refreshLastKnownGood()
    await store.refreshValidation()
  }
}

function label(kind: string): string {
  return kind === 'js' ? 'JS' : 'YAML'
}

function scopeLabel(scope: string): string {
  return scope === 'profile' ? '当前订阅' : '全局'
}

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.kind = 'yaml'
  form.scope = 'global'
  form.profileId = null
  form.content = ''
  editorOpen.value = true
}

function openEdit(item: { id: string; name: string; kind: 'yaml' | 'js'; scope: 'global' | 'profile'; profileId: string | null; content: string }): void {
  editingId.value = item.id
  form.name = item.name
  form.kind = item.kind
  form.scope = item.scope
  form.profileId = item.scope === 'profile' ? item.profileId : null
  form.content = item.content
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  editingId.value = null
}

async function save(): Promise<void> {
  if (!form.name.trim()) return
  const input: OverrideInput = {
    name: form.name.trim(),
    kind: form.kind,
    scope: form.scope,
    profileId: form.scope === 'profile' ? form.profileId ?? props.activeProfileId : null,
    content: form.content
  }
  const wasEditing = isEditing.value
  const ok = wasEditing ? await store.update(editingId.value!, input) : await store.create(input)
  if (ok) { closeEditor(); toast.success(wasEditing ? '覆写已更新' : '覆写已添加') }
  else toast.error('覆写保存失败', store.lastError ?? undefined)
}

onMounted(() => {
  void store.refresh()
})
</script>

<template>
  <section class="overrides-panel" aria-label="配置覆写">
    <header class="ov-head">
      <div>
        <h2 class="ov-title">配置覆写</h2>
        <p class="ov-subtitle">
          在订阅配置之上叠加自定义规则、分组或 DNS，无需改动订阅文件；下次启动内核时生效。
        </p>
      </div>
      <button type="button" class="ov-add" @click="openCreate"><AppIcon name="add" :size="15" />新增</button>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div v-if="store.items.length === 0" class="ov-empty">
      <p>尚未添加覆写。全局覆写作用于所有订阅；也可以为当前使用的订阅单独添加。</p>
    </div>

    <ul v-else class="ov-list">
      <li v-for="(item, index) in store.items" :key="item.id" class="ov-item">
        <span class="ov-kind" :class="`ov-kind-${item.kind}`">{{ label(item.kind) }}</span>
        <span class="ov-name">{{ item.name }}</span>
        <span class="ov-scope" :class="{ profile: item.scope === 'profile' }">
          {{ scopeLabel(item.scope) }}
        </span>
        <div class="ov-actions">
          <button
            type="button"
            class="ov-icon"
            :disabled="index === 0"
            aria-label="上移"
            title="上移"
            @click="store.move(item.id, 'up')"
          ><AppIcon name="move-up" :size="14" /></button>
          <button
            type="button"
            class="ov-icon"
            :disabled="index === store.items.length - 1"
            aria-label="下移"
            title="下移"
            @click="store.move(item.id, 'down')"
          ><AppIcon name="move-down" :size="14" /></button>
          <button type="button" class="ov-icon" aria-label="编辑" title="编辑" @click="openEdit(item)"><AppIcon name="edit" :size="14" /></button>
          <button type="button" class="ov-icon danger" aria-label="删除" title="删除" @click="store.remove(item.id)"><AppIcon name="delete" :size="14" /></button>
          <label class="ov-toggle" :title="item.enabled ? '停用' : '启用'">
            <input
              :checked="item.enabled"
              type="checkbox"
              :aria-label="`${item.enabled ? '停用' : '启用'} ${item.name}`"
              @change="store.setEnabled(item.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="ov-toggle-track" />
          </label>
        </div>
      </li>
    </ul>

    <div class="ov-tools">
      <button type="button" class="ov-tool" :disabled="store.validating" @click="runValidation">
        {{ store.validating ? '校验中…' : '校验' }}
      </button>
      <button type="button" class="ov-tool" :disabled="store.previewLoading" @click="runPreview">
        {{ store.previewLoading ? '生成中…' : '预演' }}
      </button>
      <span class="ov-tool-spacer" />
      <button type="button" class="ov-tool" :disabled="!hasLastKnownGood" title="撤销到最后一次校验通过的覆写集合" @click="rollback">
        回滚到最后可用
      </button>
    </div>

    <div v-if="store.validation" class="ov-validate" :class="{ ok: store.validation.valid, bad: !store.validation.valid }" role="status">
      <span class="ov-validate-mark"><AppIcon :name="store.validation.valid ? 'check' : 'close'" :size="15" /></span>
      <div class="ov-validate-body">
        <p class="ov-validate-head">
          {{ store.validation.valid ? '覆写校验通过' : `覆写校验未通过 · ${issueSummary()}` }}
          <span v-if="store.validation.issues.length === 0" class="ov-validate-note">将原样应用订阅配置</span>
        </p>
        <ul v-if="store.validation.issues.length > 0" class="ov-issues">
          <li v-for="(issue, index) in store.validation.issues" :key="index" :class="`ov-issue-${issue.level}`">
            <span v-if="issue.itemName" class="ov-issue-name">「{{ issue.itemName }}」</span>{{ issue.message }}
          </li>
        </ul>
      </div>
    </div>

    <div v-if="store.preview" class="ov-preview">
      <header class="ov-preview-head">
        <h3>覆写预演（已脱敏）</h3>
        <span v-if="store.preview.unavailable" class="ov-preview-note">当前没有活动的订阅</span>
        <span v-else class="ov-preview-note">红色为移除、绿色为新增，仅显示改动附近内容</span>
      </header>
      <p v-if="store.preview.unavailable" class="ov-preview-empty">{{ store.preview.warnings.join('；') }}</p>
      <div v-else class="ov-diff" aria-label="覆写差异预览">
        <div v-for="(line, index) in previewDiff" :key="index" :class="`ov-diff-line ov-diff-${line.type}`">
          <span class="ov-diff-sign">{{ line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ' }}</span>
          <span class="ov-diff-text">{{ line.text }}</span>
        </div>
      </div>
      <p v-if="store.preview.warnings.length > 0" class="ov-preview-warn">
        {{ store.preview.warnings.join('；') }}
      </p>
    </div>

    <div v-if="open" class="ov-backdrop" @click.self="closeEditor">
      <div class="ov-editor" role="dialog" aria-modal="true" aria-label="编辑覆写">
        <header class="ov-editor-head">
          <h3>{{ isEditing ? '编辑覆写' : '新增覆写' }}</h3>
          <button type="button" class="ov-icon" aria-label="关闭" @click="closeEditor"><AppIcon name="close" :size="15" /></button>
        </header>

        <div class="ov-form">
          <input v-model="form.name" class="ov-field" placeholder="覆写名称" aria-label="覆写名称" />
          <div class="ov-form-row">
            <label class="ov-label">类型</label>
            <AppSelect v-model="form.kind" :options="[{ value: 'yaml', label: 'YAML 覆写' }, { value: 'js', label: 'JS 覆写' }]" label="覆写类型" />
            <label class="ov-label">作用域</label>
            <AppSelect v-model="form.scope" :options="[{ value: 'global', label: '全局' }, { value: 'profile', label: '当前订阅', disabled: !canUseProfileScope }]" label="覆写作用域" />
          </div>
          <p v-if="form.scope === 'profile' && !canUseProfileScope" class="ov-note">
            当前没有使用中的订阅，暂无法绑定到某个订阅。
          </p>
          <textarea
            v-model="form.content"
            class="ov-textarea"
            spellcheck="false"
            :placeholder="form.kind === 'js' ? jsPlaceholder : yamlPlaceholder"
            aria-label="覆写内容"
          />
        </div>

        <footer class="ov-editor-actions">
          <button type="button" class="ov-cancel" @click="closeEditor">取消</button>
          <button type="button" class="ov-save" :disabled="!form.name.trim()" @click="save">
            {{ isEditing ? '保存' : '创建' }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.overrides-panel {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
}
.ov-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ov-title { margin: 0 0 4px; font-size: 15px; }
.ov-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.ov-add {
  min-height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 7px;
  background: var(--app-blue);
  color: white;
  font-size: 12px;
  white-space: nowrap;
}
.ov-empty { margin-top: 14px; }
.ov-empty p { margin: 0; color: var(--app-muted); font-size: 12px; }
.ov-list {
  display: grid;
  gap: 6px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
.ov-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.ov-kind {
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 600;
}
.ov-kind-yaml { background: rgba(21, 135, 248, 0.16); color: var(--app-blue); }
.ov-kind-js { background: rgba(255, 179, 64, 0.16); color: var(--app-pink); }
.ov-name { flex: 1; font-size: 12px; word-break: break-all; }
.ov-scope {
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(127, 127, 127, 0.14);
  color: var(--app-muted);
  font-size: 10px;
}
.ov-scope.profile { background: rgba(39, 203, 150, 0.16); color: var(--app-green); }
.ov-actions { display: flex; align-items: center; gap: 6px; }
.ov-icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}
.ov-icon:hover { background: rgba(127, 127, 127, 0.14); }
.ov-icon:disabled { opacity: 0.4; cursor: default; }
.ov-icon.danger:hover { background: rgba(255, 82, 82, 0.16); color: var(--app-red, #ff5252); }
.ov-toggle { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
.ov-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.ov-toggle-track {
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.28);
  position: relative;
  transition: background 0.15s ease;
}
.ov-toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  transition: transform 0.15s ease;
}
.ov-toggle input:checked + .ov-toggle-track { background: var(--app-blue); }
.ov-toggle input:checked + .ov-toggle-track::after { transform: translateX(14px); }

.ov-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.ov-editor {
  display: flex;
  flex-direction: column;
  width: 540px;
  max-height: 80vh;
  background: var(--app-surface-solid);
  border: 1px solid var(--app-divider);
  border-radius: 14px;
  box-shadow: var(--app-shadow);
  padding: 16px;
}
.ov-editor-head { display: flex; align-items: center; justify-content: space-between; }
.ov-editor-head h3 { margin: 0; font-size: 14px; }
.ov-form { display: grid; gap: 10px; margin-top: 14px; }
.ov-form-row { display: flex; align-items: center; gap: 8px; }
.ov-label { color: var(--app-muted); font-size: 11px; }
.ov-field {
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
}
.ov-field[type='text'], input.ov-field { width: 100%; }
.ov-field:focus { outline: 1px solid var(--app-blue); }
.ov-textarea {
  width: 100%;
  min-height: 220px;
  padding: 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
.ov-note { margin: 0; color: var(--app-muted); font-size: 11px; }
.ov-editor-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.ov-cancel,
.ov-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.ov-cancel { background: rgba(127, 127, 127, 0.14); color: inherit; }
.ov-save { background: var(--app-blue); color: white; }
.ov-cancel:disabled,
.ov-save:disabled { opacity: 0.6; }

.ov-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.ov-tool-spacer { flex: 1; }
.ov-tool {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
}
.ov-tool:hover { border-color: var(--app-blue); }
.ov-tool:disabled { opacity: 0.45; cursor: default; }

.ov-validate {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.ov-validate.ok { border-color: rgba(39, 203, 150, 0.35); }
.ov-validate.bad { border-color: rgba(255, 82, 82, 0.4); }
.ov-validate-mark { font-weight: 700; font-size: 13px; }
.ov-validate.ok .ov-validate-mark { color: var(--app-green); }
.ov-validate.bad .ov-validate-mark { color: var(--app-red, #ff5252); }
.ov-validate-body { flex: 1; }
.ov-validate-head { margin: 0; font-size: 12px; }
.ov-validate-note { margin-left: 8px; color: var(--app-muted); font-size: 11px; }
.ov-issues { margin: 6px 0 0; padding: 0; list-style: none; }
.ov-issues li { font-size: 11px; line-height: 1.5; }
.ov-issue-error { color: var(--app-red, #ff5252); }
.ov-issue-warning { color: var(--app-muted); }
.ov-issue-name { font-weight: 600; }

.ov-preview {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.ov-preview-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.ov-preview-head h3 { margin: 0; font-size: 12px; }
.ov-preview-note { color: var(--app-muted); font-size: 11px; }
.ov-preview-empty { margin: 0; color: var(--app-muted); font-size: 11px; }
.ov-preview-warn {
  margin: 8px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--app-divider);
  color: var(--app-pink);
  font-size: 11px;
}
.ov-diff {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
}
.ov-diff-line { display: flex; gap: 6px; padding: 0 8px; white-space: pre; }
.ov-diff-context { color: var(--app-muted); }
.ov-diff-added { background: rgba(39, 203, 150, 0.16); color: var(--app-green); }
.ov-diff-removed { background: rgba(255, 82, 82, 0.14); color: var(--app-red, #ff5252); }
.ov-diff-sign { user-select: none; width: 10px; text-align: center; opacity: 0.7; }
</style>
