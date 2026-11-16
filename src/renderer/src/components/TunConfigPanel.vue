<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useTunConfigStore } from '../stores/tun-config'
import { EMPTY_TUN_CONFIG, type TunConfigModel } from '@shared/tun-config'
import AppSelect from './AppSelect.vue'
import AppIcon from './AppIcon.vue'
import ConfirmModal from './ConfirmModal.vue'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { plainJsonClone } from '@shared/plain-clone'

const store = useTunConfigStore()
const toast = useToast()
const hydrated = ref(false)
const resetOpen = ref(false)

const form = reactive<TunConfigModel>({ ...EMPTY_TUN_CONFIG })

const dnsHijackText = ref('')
const routeAddressText = ref('')
const routeExcludeAddressText = ref('')

const previewYaml = ref('')
const previewOpen = ref(false)

/** Optional mihomo TUN adapter labels, kept short for the select options. */
const STACK_OPTIONS: Array<{ value: TunConfigModel['stack']; label: string }> = [
  { value: 'mixed', label: 'mixed' },
  { value: 'system', label: 'system' },
  { value: 'gvisor', label: 'gvisor' }
]

function listToText(list: string[]): string {
  return list.join('\n')
}
function textToList(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

function syncFromConfig(value: TunConfigModel): void {
  form.stack = value.stack
  form.device = value.device
  form.mtu = value.mtu
  form.strictRoute = value.strictRoute
  form.autoRoute = value.autoRoute
  form.autoDetectInterface = value.autoDetectInterface
  form.dnsHijack = [...value.dnsHijack]
  form.routeAddress = [...value.routeAddress]
  form.routeExcludeAddress = [...value.routeExcludeAddress]

  dnsHijackText.value = listToText(value.dnsHijack)
  routeAddressText.value = listToText(value.routeAddress)
  routeExcludeAddressText.value = listToText(value.routeExcludeAddress)
}

function buildInput(): TunConfigModel {
  return {
    ...form,
    dnsHijack: textToList(dnsHijackText.value),
    routeAddress: textToList(routeAddressText.value),
    routeExcludeAddress: textToList(routeExcludeAddressText.value)
  }
}

async function save(): Promise<void> {
  const ok = await store.save(buildInput())
  if (ok) { syncFromConfig(store.config); toast.success(t('tunConfig.saved'), t('tunConfig.appliesNext')) }
  else toast.error(t('tunConfig.saveFailed'), store.lastError ?? undefined)
}

async function preview(): Promise<void> {
  previewYaml.value = await store.preview(buildInput())
  previewOpen.value = true
}

function requestReset(): void {
  resetOpen.value = true
}
function restoreSaved(): void { syncFromConfig(store.config) }

async function confirmReset(): Promise<void> {
  const ok = await store.save(plainJsonClone(EMPTY_TUN_CONFIG))
  if (ok) {
    syncFromConfig(store.config)
    resetOpen.value = false
    toast.success(t('tunConfig.resetDone'), t('tunConfig.appliesNext'))
  } else toast.error(t('tunConfig.resetFailed'), store.lastError ?? undefined)
}

const dirty = computed(() => hydrated.value && JSON.stringify(buildInput()) !== JSON.stringify(store.config))
useUnsavedChanges('tun-config', t('tunConfig.name'), dirty)

watch(
  () => store.config,
  (value) => syncFromConfig(value),
  { deep: true }
)

onMounted(async () => {
  await store.refresh()
  syncFromConfig(store.config)
  hydrated.value = true
})
</script>

<template>
  <section class="tun-panel" :aria-label="t('tunConfig.title')">
    <header class="tun-head">
      <div>
        <h2 class="tun-title">{{ t('tunConfig.title') }}</h2>
        <p class="tun-subtitle">
          {{ t('tunConfig.intro') }}
        </p>
      </div>
      <div v-if="dirty" class="tun-head-actions"><button type="button" class="tun-reset" @click="restoreSaved">{{ t('common.revertChanges') }}</button><button type="button" class="tun-reset" @click="requestReset">{{ t('common.restoreDefaults') }}</button></div>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="tun-body">
      <fieldset class="tun-group">
        <legend>{{ t('tunConfig.stackTitle') }}</legend>
        <div class="tun-grid">
          <label class="tun-field">
            <span class="tun-label">{{ t('tunConfig.stack') }}</span>
            <AppSelect v-model="form.stack" :options="STACK_OPTIONS" :label="t('tunConfig.stackLabel')" />
          </label>
          <label class="tun-field">
            <span class="tun-label">{{ t('tunConfig.device') }}</span>
            <input v-model="form.device" class="tun-input" spellcheck="false" placeholder="Mihomo" />
          </label>
          <label class="tun-field">
            <span class="tun-label">{{ t('tunConfig.mtu') }}</span>
            <input v-model.number="form.mtu" class="tun-input" type="number" min="576" max="65535" />
          </label>
        </div>
      </fieldset>

      <fieldset class="tun-group">
        <legend>{{ t('tunConfig.routing') }}</legend>
        <div class="tun-grid">
          <label class="tun-switch small">
            <input v-model="form.autoRoute" type="checkbox" aria-label="auto-route" />
            <span class="tun-switch-track" />
            <span class="tun-label">{{ t('tunConfig.autoRoute') }}</span>
          </label>
          <label class="tun-switch small">
            <input v-model="form.autoDetectInterface" type="checkbox" aria-label="auto-detect-interface" />
            <span class="tun-switch-track" />
            <span class="tun-label">{{ t('tunConfig.autoDetect') }}</span>
          </label>
          <label class="tun-switch small">
            <input v-model="form.strictRoute" type="checkbox" aria-label="strict-route" />
            <span class="tun-switch-track" />
            <span class="tun-label">{{ t('tunConfig.strictRoute') }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="tun-group">
        <legend>{{ t('tunConfig.dnsHijack') }}</legend>
        <div class="tun-grid">
          <label class="tun-field">
            <span class="tun-label">{{ t('tunConfig.dnsHijackHint') }}</span>
            <textarea v-model="dnsHijackText" class="tun-textarea" spellcheck="false" placeholder="any:53" />
          </label>
        </div>
      </fieldset>

      <fieldset class="tun-group">
        <legend>{{ t('tunConfig.routeAddresses') }}</legend>
        <div class="tun-grid">
          <label class="tun-field">
            <span class="tun-label">{{ t('tunConfig.routeInclude') }}</span>
            <textarea v-model="routeAddressText" class="tun-textarea" spellcheck="false" placeholder="192.168.0.0/16" />
          </label>
          <label class="tun-field">
            <span class="tun-label">{{ t('tunConfig.routeExclude') }}</span>
            <textarea v-model="routeExcludeAddressText" class="tun-textarea" spellcheck="false" placeholder="10.0.0.0/8" />
          </label>
        </div>
      </fieldset>

      <div class="tun-actions">
        <button type="button" class="tun-preview" @click="preview">{{ t('common.previewConfig') }}</button>
        <span v-if="dirty" class="unsaved-indicator">{{ t('common.unsaved') }}</span><button type="button" class="tun-save" :disabled="store.busy || !dirty" @click="save">{{ store.busy ? t('common.saving') : t('common.save') }}</button>
      </div>

      <div v-if="previewOpen" class="tun-preview">
        <div class="tun-preview-head">
          <span>{{ t('tunConfig.previewTitle') }}</span>
          <button type="button" class="tun-icon" :aria-label="t('common.closePreview')" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="tun-preview-body">{{ previewYaml || t('common.emptyParen') }}</pre>
      </div>
      <ConfirmModal :open="resetOpen" :title="t('tunConfig.resetTitle')" :description="t('tunConfig.resetDescription')" :confirm-label="t('common.restoreDefaults')" :busy="store.busy" @close="resetOpen = false" @confirm="confirmReset" />
    </div>
  </section>
</template>

<style scoped>
.tun-panel {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
}
.tun-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
}
.tun-title { margin: 0 0 4px; font-size: var(--font-size-lg); }
.tun-subtitle { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; max-width: 560px; }
.tun-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-panel);
  color: inherit;
  font-size: var(--font-size-sm);
  white-space: nowrap;
}
.tun-head-actions { display: flex; align-items: center; gap: var(--space-3); flex: none; }
.tun-body { margin-top: 14px; display: grid; gap: var(--space-6); }
.tun-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.tun-group legend { padding: 0 6px; color: var(--app-muted); font-size: var(--font-size-xs); }
.tun-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
.tun-field { display: grid; gap: var(--space-2); }
.tun-label { color: var(--app-muted); font-size: var(--font-size-xs); }
.tun-input,
.tun-select {
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
}
.tun-textarea {
  width: 100%;
  min-height: 72px;
  padding: 8px 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
.tun-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.tun-preview,
.tun-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
}
.tun-preview { background: var(--app-fill); color: inherit; }
.tun-save { background: var(--app-blue); color: var(--app-on-accent); }
.tun-save:disabled { opacity: 0.6; }
.tun-switch { position: relative; display: inline-flex; align-items: center; gap: var(--space-3); cursor: pointer; }
.tun-switch.small { min-height: 34px; }
.tun-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.tun-switch-track {
  width: 34px;
  height: 20px;
  border-radius: var(--radius-md);
  background: var(--app-fill-strong);
  position: relative;
  transition: background 0.15s ease;
  flex: none;
}
.tun-switch-track::after {
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
.tun-switch input:checked + .tun-switch-track { background: var(--app-blue); }
.tun-switch input:checked + .tun-switch-track::after { transform: translateX(14px); }
.tun-preview {
  display: grid;
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.tun-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: var(--font-size-xs);
}
.tun-icon {
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
.tun-preview-body {
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
