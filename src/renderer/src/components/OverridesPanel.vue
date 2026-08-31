<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useOverridesStore } from '../stores/overrides'
import type { OverrideInput } from '@shared/overrides'

const props = defineProps<{ activeProfileId: string | null }>()

const store = useOverridesStore()

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
  const ok = isEditing.value ? await store.update(editingId.value!, input) : await store.create(input)
  if (ok) closeEditor()
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
      <button type="button" class="ov-add" @click="openCreate">+ 新增</button>
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
          >↑</button>
          <button
            type="button"
            class="ov-icon"
            :disabled="index === store.items.length - 1"
            aria-label="下移"
            title="下移"
            @click="store.move(item.id, 'down')"
          >↓</button>
          <button type="button" class="ov-icon" aria-label="编辑" title="编辑" @click="openEdit(item)">✎</button>
          <button type="button" class="ov-icon danger" aria-label="删除" title="删除" @click="store.remove(item.id)">✕</button>
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

    <div v-if="open" class="ov-backdrop" @click.self="closeEditor">
      <div class="ov-editor" role="dialog" aria-modal="true" aria-label="编辑覆写">
        <header class="ov-editor-head">
          <h3>{{ isEditing ? '编辑覆写' : '新增覆写' }}</h3>
          <button type="button" class="ov-icon" aria-label="关闭" @click="closeEditor">✕</button>
        </header>

        <div class="ov-form">
          <input v-model="form.name" class="ov-field" placeholder="覆写名称" aria-label="覆写名称" />
          <div class="ov-form-row">
            <label class="ov-label">类型</label>
            <select v-model="form.kind" class="ov-field">
              <option value="yaml">YAML 覆写</option>
              <option value="js">JS 覆写</option>
            </select>
            <label class="ov-label">作用域</label>
            <select v-model="form.scope" class="ov-field">
              <option value="global">全局</option>
              <option value="profile" :disabled="!canUseProfileScope">当前订阅</option>
            </select>
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
</style>
