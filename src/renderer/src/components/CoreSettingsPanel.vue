<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useCoreSettingsStore } from '../stores/core-settings'
import type { CoreSettings } from '@shared/core-settings'
import { EMPTY_CORE_SETTINGS } from '@shared/core-settings'
import AppSelect from './AppSelect.vue'
import AppIcon from './AppIcon.vue'
import { useToast } from '../composables/use-toast'

const store = useCoreSettingsStore()
const toast = useToast()

const form = reactive<CoreSettings>({ ...EMPTY_CORE_SETTINGS })

const previewYaml = ref('')
const previewOpen = ref(false)

/** mihomo `log-level` options (the values mihomo itself accepts). */
const LOG_LEVEL_OPTIONS: Array<{ value: CoreSettings['logLevel']; label: string }> = [
  { value: 'silent', label: 'silent' },
  { value: 'error', label: 'error' },
  { value: 'warning', label: 'warning' },
  { value: 'info', label: 'info' },
  { value: 'debug', label: 'debug' }
]

/** mihomo `find-process-mode` options. */
const FIND_PROCESS_OPTIONS: Array<{ value: CoreSettings['findProcessMode']; label: string }> = [
  { value: 'off', label: 'off' },
  { value: 'strict', label: 'strict' },
  { value: 'always', label: 'always' }
]

function syncFromConfig(value: CoreSettings): void {
  form.enabled = value.enabled
  form.logLevel = value.logLevel
  form.ipv6 = value.ipv6
  form.tcpConcurrent = value.tcpConcurrent
  form.unifiedDelay = value.unifiedDelay
  form.findProcessMode = value.findProcessMode
}

async function save(): Promise<void> {
  const ok = await store.save({ ...form })
  if (ok) { syncFromConfig(store.settings); toast.success('内核设置已保存') }
  else toast.error('内核设置保存失败', store.lastError ?? undefined)
}

async function preview(): Promise<void> {
  previewYaml.value = await store.preview({ ...form })
  previewOpen.value = true
}

function resetFromStore(): void {
  syncFromConfig(store.settings)
}

watch(
  () => store.settings,
  (value) => syncFromConfig(value),
  { deep: true }
)

onMounted(async () => {
  await store.refresh()
  syncFromConfig(store.settings)
})
</script>

<template>
  <section class="core-panel" aria-label="mihomo 核心设置">
    <header class="core-head">
      <div>
        <h2 class="core-title">mihomo 核心设置</h2>
        <p class="core-subtitle">
          控制 mihomo 运行时核心参数（日志级别、IPv6、并发拨号、统一延迟、进程匹配），不修改订阅源文件；当启用时这些值会在运行时配置中生效并覆盖配置文件的同名项。
        </p>
      </div>
      <button type="button" class="core-reset" @click="resetFromStore">重置</button>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <p v-if="!form.enabled" class="core-hint">
      当前未启用，运行时会保留配置文件自身的核心设置（不会覆盖）。
    </p>

    <div class="core-body">
      <fieldset class="core-group">
        <legend>启用</legend>
        <label class="core-switch inline">
          <input v-model="form.enabled" type="checkbox" aria-label="启用核心设置覆盖" />
          <span class="core-switch-track" />
          <span class="core-label">启用后覆盖配置文件的同名核心参数</span>
        </label>
      </fieldset>

      <fieldset class="core-group">
        <legend>运行参数</legend>
        <div class="core-grid">
          <label class="core-field">
            <span class="core-label">log-level</span>
            <AppSelect v-model="form.logLevel" :options="LOG_LEVEL_OPTIONS" label="日志级别" />
          </label>
          <label class="core-field">
            <span class="core-label">find-process-mode</span>
            <AppSelect v-model="form.findProcessMode" :options="FIND_PROCESS_OPTIONS" label="进程查找模式" />
          </label>
        </div>
      </fieldset>

      <fieldset class="core-group">
        <legend>特性开关</legend>
        <div class="core-grid">
          <label class="core-switch small">
            <input v-model="form.ipv6" type="checkbox" aria-label="ipv6" />
            <span class="core-switch-track" />
            <span class="core-label"> ipv6</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.tcpConcurrent" type="checkbox" aria-label="tcp-concurrent" />
            <span class="core-switch-track" />
            <span class="core-label"> tcp-concurrent</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.unifiedDelay" type="checkbox" aria-label="unified-delay" />
            <span class="core-switch-track" />
            <span class="core-label"> unified-delay</span>
          </label>
        </div>
      </fieldset>

      <div class="core-actions">
        <button type="button" class="core-preview" @click="preview">预览配置</button>
        <button type="button" class="core-save" :disabled="store.busy" @click="save">{{ store.busy ? '保存中…' : '保存' }}</button>
      </div>

      <div v-if="previewOpen" class="core-preview">
        <div class="core-preview-head">
          <span>运行时生效的 mihomo 核心键</span>
          <button type="button" class="core-icon" aria-label="关闭预览" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="core-preview-body">{{ previewYaml || '（空）' }}</pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.core-panel {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
}
.core-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.core-title { margin: 0 0 4px; font-size: 15px; }
.core-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.core-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.core-body { margin-top: 14px; display: grid; gap: 14px; }
.core-hint {
  margin: 0 0 0;
  padding: 0;
  color: var(--app-muted);
  font-size: 11px;
}
.core-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.core-group legend { padding: 0 6px; color: var(--app-muted); font-size: 11px; }
.core-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.core-field { display: grid; gap: 5px; }
.core-label { color: var(--app-muted); font-size: 11px; }
.core-select,
.core-input {
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  color: inherit;
  font-size: 12px;
}
.core-actions { display: flex; justify-content: flex-end; gap: 8px; }
.core-preview,
.core-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.core-preview { background: rgba(127, 127, 127, 0.14); color: inherit; }
.core-save { background: var(--app-blue); color: white; }
.core-save:disabled { opacity: 0.6; }
.core-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.core-switch.inline { min-height: 34px; }
.core-switch.small { min-height: 34px; }
.core-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.core-switch-track {
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.28);
  position: relative;
  transition: background 0.15s ease;
  flex: none;
}
.core-switch-track::after {
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
.core-switch input:checked + .core-switch-track { background: var(--app-blue); }
.core-switch input:checked + .core-switch-track::after { transform: translateX(14px); }
.core-preview {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.core-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: 11px;
}
.core-icon {
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
.core-preview-body {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
}
</style>
