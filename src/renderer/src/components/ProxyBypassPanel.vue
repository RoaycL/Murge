<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useProxyBypassStore } from '../stores/proxy-bypass'
import { useSystemProxyStore } from '../stores/system-proxy'
import type { ProxyBypassPolicy } from '@shared/proxy-bypass'
import { EMPTY_PROXY_BYPASS_POLICY, MAX_CUSTOM_BYPASS_ENTRIES } from '@shared/proxy-bypass'

const store = useProxyBypassStore()
const systemProxy = useSystemProxyStore()

const form = reactive<ProxyBypassPolicy>({ ...EMPTY_PROXY_BYPASS_POLICY })
const entryText = ref('')
const previewValue = ref('')
const previewOpen = ref(false)

const systemProxyEnabled = computed(() => systemProxy.status.phase === 'enabled')
const effectiveOverride = computed(() => systemProxy.status.proxyOverride)

function syncFromPolicy(value: ProxyBypassPolicy): void {
  form.enabled = value.enabled
  form.customEntries = [...value.customEntries]
  entryText.value = value.customEntries.join('\n')
}

function parseEntries(): string[] {
  // One entry per line; trim and drop empties the same way the main process does.
  return entryText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_CUSTOM_BYPASS_ENTRIES)
}

async function save(): Promise<void> {
  const ok = await store.save({ enabled: form.enabled, customEntries: parseEntries() })
  if (ok) {
    syncFromPolicy(store.policy)
    await systemProxy.refresh()
  }
}

async function preview(): Promise<void> {
  previewValue.value = await store.preview({ enabled: form.enabled, customEntries: parseEntries() })
  previewOpen.value = true
}

function resetFromStore(): void {
  syncFromPolicy(store.policy)
  previewOpen.value = false
}

watch(
  () => store.policy,
  (value) => syncFromPolicy(value),
  { deep: true }
)

onMounted(async () => {
  await Promise.all([store.refresh(), systemProxy.refresh()])
  syncFromPolicy(store.policy)
})
</script>

<template>
  <section class="pb-panel" aria-label="mihomo 系统代理绕过设置">
    <header class="pb-head">
      <div>
        <h2 class="pb-title">系统代理绕过策略</h2>
        <p class="pb-subtitle">
          控制应用所拥有系统代理的 <code>ProxyOverride</code>。启用后你自定义的绕过项会与内置的本地/私有地址绕过项合并写入；关闭时保留系统原有的绕过列表，绝不丢弃已有项。无论编辑多少次，禁用系统代理时都精确还原起初的原始值。
        </p>
      </div>
      <button type="button" class="pb-reset" @click="resetFromStore">重置</button>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <p v-if="!form.enabled" class="pb-hint">当前未启用，系统代理启用时会保留系统原有的绕过列表（不会被覆盖）。</p>

    <div class="pb-body">
      <fieldset class="pb-group">
        <legend>启用</legend>
        <label class="pb-switch inline">
          <input v-model="form.enabled" type="checkbox" aria-label="启用绕过策略" />
          <span class="pb-switch-track" />
          <span class="pb-label">启用后以自定义绕过列表为准（与内置本地绕过项合并）</span>
        </label>
      </fieldset>

      <fieldset class="pb-group">
        <legend>自定义绕过项</legend>
        <label class="pb-field">
          <span class="pb-label">每行一个（例如 *.example.com、10.*、localhost）</span>
          <textarea
            v-model="entryText"
            class="pb-textarea"
            rows="4"
            spellcheck="false"
            placeholder="填入需要绕过代理的域名/地址，一行一个"
            aria-label="自定义绕过项"
          />
        </label>
        <p class="pb-note">当前 {{ parseEntries().length }} 项（上限 {{ MAX_CUSTOM_BYPASS_ENTRIES }}）。</p>
      </fieldset>

      <div class="pb-current" v-if="systemProxyEnabled">
        <span class="pb-label">系统代理当前状态</span>
        <span class="pb-effective" aria-label="当前生效的 ProxyOverride">{{ effectiveOverride || '（未报告）' }}</span>
      </div>

      <div class="pb-actions">
        <button type="button" class="pb-preview" @click="preview">预览 ProxyOverride</button>
        <button type="button" class="pb-save" :disabled="store.busy" @click="save">保存</button>
      </div>

      <div v-if="previewOpen" class="pb-preview">
        <div class="pb-preview-head">
          <span>将写入的 ProxyOverride 值</span>
          <button type="button" class="pb-icon" aria-label="关闭预览" @click="previewOpen = false">✕</button>
        </div>
        <pre class="pb-preview-body">{{ previewValue || '（空）' }}</pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pb-panel {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
}
.pb-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.pb-title { margin: 0 0 4px; font-size: 15px; }
.pb-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.pb-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.pb-body { margin-top: 14px; display: grid; gap: 14px; }
.pb-hint { margin: 0; color: var(--app-muted); font-size: 11px; }
.pb-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.pb-group legend { padding: 0 6px; color: var(--app-muted); font-size: 11px; }
.pb-field { display: grid; gap: 5px; }
.pb-label { color: var(--app-muted); font-size: 11px; }
.pb-note { margin: 6px 0 0; color: var(--app-muted); font-size: 10px; }
.pb-textarea {
  width: 100%;
  min-height: 90px;
  padding: 8px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  color: inherit;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
.pb-current {
  display: grid;
  gap: 5px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.pb-effective {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
.pb-actions { display: flex; justify-content: flex-end; gap: 8px; }
.pb-preview,
.pb-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.pb-preview { background: rgba(127, 127, 127, 0.14); color: inherit; }
.pb-save { background: var(--app-blue); color: white; }
.pb-save:disabled { opacity: 0.6; }
.pb-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.pb-switch.inline { min-height: 34px; }
.pb-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.pb-switch-track {
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.28);
  position: relative;
  transition: background 0.15s ease;
  flex: none;
}
.pb-switch-track::after {
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
.pb-switch input:checked + .pb-switch-track { background: var(--app-blue); }
.pb-switch input:checked + .pb-switch-track::after { transform: translateX(14px); }
.pb-preview {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.pb-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: 11px;
}
.pb-icon {
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
.pb-preview-body {
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
