<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useProxyBypassStore } from '../stores/proxy-bypass'
import { useSystemProxyStore } from '../stores/system-proxy'
import type { ProxyBypassPolicy } from '@shared/proxy-bypass'
import { EMPTY_PROXY_BYPASS_POLICY, MAX_CUSTOM_BYPASS_ENTRIES } from '@shared/proxy-bypass'
import AppIcon from './AppIcon.vue'
import ConfirmModal from './ConfirmModal.vue'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { plainJsonClone } from '@shared/plain-clone'

const store = useProxyBypassStore()
const toast = useToast()
const hydrated = ref(false)
const systemProxy = useSystemProxyStore()
const resetOpen = ref(false)

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
    toast.success(t('bypass.saved'))
  }
  else toast.error(t('bypass.saveFailed'), store.lastError ?? undefined)
}

async function preview(): Promise<void> {
  previewValue.value = await store.preview({ enabled: form.enabled, customEntries: parseEntries() })
  previewOpen.value = true
}

function requestReset(): void {
  resetOpen.value = true
}
function restoreSaved(): void { syncFromPolicy(store.policy); previewOpen.value = false }

async function confirmReset(): Promise<void> {
  const ok = await store.save(plainJsonClone(EMPTY_PROXY_BYPASS_POLICY))
  if (ok) {
    syncFromPolicy(store.policy)
    await systemProxy.refresh()
    previewOpen.value = false
    resetOpen.value = false
    toast.success(t('bypass.resetDone'))
  } else toast.error(t('bypass.resetFailed'), store.lastError ?? undefined)
}

const dirty = computed(() => hydrated.value && JSON.stringify({ enabled: form.enabled, customEntries: parseEntries() }) !== JSON.stringify(store.policy))
useUnsavedChanges('proxy-bypass', t('bypass.name'), dirty)

watch(
  () => store.policy,
  (value) => syncFromPolicy(value),
  { deep: true }
)

onMounted(async () => {
  await Promise.all([store.refresh(), systemProxy.refresh()])
  syncFromPolicy(store.policy)
  hydrated.value = true
})
</script>

<template>
  <section class="pb-panel" :aria-label="t('bypass.label')">
    <header class="pb-head">
      <div>
        <h2 class="pb-title">{{ t('bypass.title') }}</h2>
        <p class="pb-subtitle">
          {{ t('bypass.intro') }}
        </p>
      </div>
      <div v-if="dirty" class="pb-head-actions"><button type="button" class="pb-reset" @click="restoreSaved">{{ t('common.revertChanges') }}</button><button type="button" class="pb-reset" @click="requestReset">{{ t('common.restoreDefaults') }}</button></div>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <p v-if="!form.enabled" class="pb-hint">{{ t('bypass.disabledHint') }}</p>

    <div class="pb-body">
      <fieldset class="pb-group">
        <legend>{{ t('common.enable') }}</legend>
        <label class="pb-switch inline">
          <input v-model="form.enabled" type="checkbox" :aria-label="t('bypass.enableLabel')" />
          <span class="pb-switch-track" />
          <span class="pb-label">{{ t('bypass.enableHint') }}</span>
        </label>
      </fieldset>

      <fieldset class="pb-group">
        <legend>{{ t('bypass.custom') }}</legend>
        <label class="pb-field">
          <span class="pb-label">{{ t('bypass.customHint') }}</span>
          <textarea
            v-model="entryText"
            class="pb-textarea"
            rows="4"
            spellcheck="false"
            :placeholder="t('bypass.customPlaceholder')"
            :aria-label="t('bypass.custom')"
          />
        </label>
        <p class="pb-note">{{ t('bypass.count', [parseEntries().length, MAX_CUSTOM_BYPASS_ENTRIES]) }}</p>
      </fieldset>

      <div class="pb-current" v-if="systemProxyEnabled">
        <span class="pb-label">{{ t('bypass.currentState') }}</span>
        <span class="pb-effective" :aria-label="t('bypass.currentLabel')">{{ effectiveOverride || t('bypass.notReported') }}</span>
      </div>

      <div class="pb-actions">
        <button type="button" class="pb-preview" @click="preview">{{ t('bypass.preview') }}</button>
        <span v-if="dirty" class="unsaved-indicator">{{ t('common.unsaved') }}</span><button type="button" class="pb-save" :disabled="store.busy || !dirty" @click="save">{{ store.busy ? t('common.saving') : t('common.save') }}</button>
      </div>

      <div v-if="previewOpen" class="pb-preview">
        <div class="pb-preview-head">
          <span>{{ t('bypass.previewTitle') }}</span>
          <button type="button" class="pb-icon" :aria-label="t('common.closePreview')" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="pb-preview-body">{{ previewValue || t('common.emptyParen') }}</pre>
      </div>
      <ConfirmModal :open="resetOpen" :title="t('bypass.resetTitle')" :description="t('bypass.resetDescription')" :confirm-label="t('common.restoreDefaults')" :busy="store.busy" @close="resetOpen = false" @confirm="confirmReset" />
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
  gap: var(--space-5);
}
.pb-title { margin: 0 0 4px; font-size: var(--font-size-lg); }
.pb-subtitle { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; max-width: 560px; }
.pb-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-panel);
  color: inherit;
  font-size: var(--font-size-sm);
  white-space: nowrap;
}
.pb-head-actions { display: flex; align-items: center; gap: var(--space-3); flex: none; }
.pb-body { margin-top: 14px; display: grid; gap: var(--space-6); }
.pb-hint { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); }
.pb-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.pb-group legend { padding: 0 6px; color: var(--app-muted); font-size: var(--font-size-xs); }
.pb-field { display: grid; gap: var(--space-2); }
.pb-label { color: var(--app-muted); font-size: var(--font-size-xs); }
.pb-note { margin: 6px 0 0; color: var(--app-muted); font-size: var(--font-size-2xs); }
.pb-textarea {
  width: 100%;
  min-height: 90px;
  padding: 8px 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
.pb-current {
  display: grid;
  gap: var(--space-2);
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.pb-effective {
  font-size: var(--font-size-xs);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
.pb-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.pb-preview,
.pb-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
}
.pb-preview { background: var(--app-fill); color: inherit; }
.pb-save { background: var(--app-blue); color: var(--app-on-accent); }
.pb-save:disabled { opacity: 0.6; }
.pb-switch { position: relative; display: inline-flex; align-items: center; gap: var(--space-3); cursor: pointer; }
.pb-switch.inline { min-height: 34px; }
.pb-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.pb-switch-track {
  width: 34px;
  height: 20px;
  border-radius: var(--radius-md);
  background: var(--app-fill-strong);
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
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.pb-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: var(--font-size-xs);
}
.pb-icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font-size: var(--font-size-md);
  cursor: pointer;
}
.pb-preview-body {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  font-size: var(--font-size-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
}
</style>
