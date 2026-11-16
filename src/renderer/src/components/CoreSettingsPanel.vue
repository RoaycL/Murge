<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useCoreSettingsStore } from '../stores/core-settings'
import type { CoreSettings } from '@shared/core-settings'
import { EMPTY_CORE_SETTINGS } from '@shared/core-settings'
import AppSelect from './AppSelect.vue'
import AppIcon from './AppIcon.vue'
import ConfirmModal from './ConfirmModal.vue'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { plainJsonClone } from '@shared/plain-clone'

const store = useCoreSettingsStore()
const toast = useToast()
const hydrated = ref(false)
const networkInterfaces = ref<string[]>([])
const resetOpen = ref(false)
const secretVisible = ref(false)

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

const INTERFACE_OPTIONS = computed(() => {
  const names = new Set(networkInterfaces.value)
  if (form.interfaceName) names.add(form.interfaceName)
  return [
    { value: '', label: t('core.autoSelect') },
    ...[...names].map((name) => ({ value: name, label: name }))
  ]
})
const CONTROLLER_HOST_OPTIONS = [
  { value: '127.0.0.1', label: t('core.bindLocal') },
  { value: '0.0.0.0', label: t('core.bindAll') }
]

function syncFromConfig(value: CoreSettings): void {
  form.enabled = value.enabled
  form.logLevel = value.logLevel
  form.ipv6 = value.ipv6
  form.tcpConcurrent = value.tcpConcurrent
  form.unifiedDelay = value.unifiedDelay
  form.storeSelected = value.storeSelected
  form.storeFakeIp = value.storeFakeIp
  form.findProcessMode = value.findProcessMode
  form.interfaceName = value.interfaceName
  form.mixedPort = value.mixedPort
  form.socksPort = value.socksPort
  form.httpPort = value.httpPort
  form.controllerHost = value.controllerHost
  form.controllerPort = value.controllerPort
  form.controllerSecret = value.controllerSecret
  form.controllerPanel = value.controllerPanel
  form.allowLan = value.allowLan
}

async function save(): Promise<void> {
  const ok = await store.save({ ...form })
  if (ok) { syncFromConfig(store.settings); toast.success(t('core.saved')) }
  else toast.error(t('core.saveFailed'), store.lastError ?? undefined)
}

async function preview(): Promise<void> {
  previewYaml.value = await store.preview({ ...form })
  previewOpen.value = true
}

function requestReset(): void {
  resetOpen.value = true
}

function restoreSaved(): void { syncFromConfig(store.settings) }

async function confirmReset(): Promise<void> {
  const ok = await store.save(plainJsonClone(EMPTY_CORE_SETTINGS))
  if (ok) {
    syncFromConfig(store.settings)
    resetOpen.value = false
    toast.success(t('core.resetDone'))
  } else toast.error(t('core.resetFailed'), store.lastError ?? undefined)
}

const dirty = computed(() => hydrated.value && JSON.stringify({ ...form }) !== JSON.stringify(store.settings))
useUnsavedChanges('core-settings', t('core.name'), dirty)

watch(
  () => store.settings,
  (value) => syncFromConfig(value),
  { deep: true }
)

onMounted(async () => {
  const [, interfaces] = await Promise.all([
    store.refresh(),
    window.desktop.app.listNetworkInterfaces().catch(() => [] as string[])
  ])
  networkInterfaces.value = interfaces
  syncFromConfig(store.settings)
  hydrated.value = true
})
</script>

<template>
  <section class="core-panel" :aria-label="t('core.label')">
    <header class="core-head">
      <div>
        <h2 class="core-title">{{ t('core.title') }}</h2>
        <p class="core-subtitle">
          {{ t('core.intro') }}
        </p>
      </div>
      <div v-if="dirty" class="core-head-actions">
        <button type="button" class="core-reset" @click="restoreSaved">{{ t('common.revertChanges') }}</button>
        <button type="button" class="core-reset" @click="requestReset">{{ t('common.restoreDefaults') }}</button>
      </div>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <p v-if="!form.enabled" class="core-hint">
      {{ t('core.disabledHint') }}
    </p>

    <div class="core-body">
      <fieldset class="core-group listener-group">
        <legend>{{ t('core.listenTitle') }}</legend>
        <p class="listener-note">{{ t('core.listenHint') }}</p>
        <div class="listener-list">
          <label class="listener-row">
            <span><b>{{ t('core.mixedPort') }}</b><small>{{ t('core.mixedPortHint') }}</small></span>
            <input v-model.number="form.mixedPort" class="core-input port-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="mixed-port" />
          </label>
          <label class="listener-row">
            <span><b>{{ t('core.socksPort') }}</b><small>{{ t('core.socksPortHint') }}</small></span>
            <input v-model.number="form.socksPort" class="core-input port-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="socks-port" />
          </label>
          <label class="listener-row">
            <span><b>{{ t('core.httpPort') }}</b><small>{{ t('core.httpPortHint') }}</small></span>
            <input v-model.number="form.httpPort" class="core-input port-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="http-port" />
          </label>
          <label class="listener-row">
            <span><b>{{ t('core.controllerListen') }}</b><small>{{ t('core.controllerListenHint') }}</small></span>
            <span class="controller-address"><AppSelect v-model="form.controllerHost" :options="CONTROLLER_HOST_OPTIONS" :label="t('core.controllerAddressLabel')" /><input v-model.number="form.controllerPort" class="core-input port-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="controller-port" /></span>
          </label>
          <label class="listener-row">
            <span><b>{{ t('core.secret') }}</b><small>{{ t('core.secretHint') }}</small></span>
            <span class="secret-field"><input v-model.trim="form.controllerSecret" class="core-input secret-input" :type="secretVisible ? 'text' : 'password'" autocomplete="off" :aria-label="t('core.secret')" /><button type="button" class="secret-eye" :aria-label="secretVisible ? t('core.hideSecret') : t('core.showSecret')" @click.prevent="secretVisible = !secretVisible"><AppIcon name="eye" :size="16" /></button></span>
          </label>
          <label class="listener-row">
            <span><b>{{ t('core.dashboard') }}</b><small>{{ t('core.dashboardHint') }}</small></span>
            <span class="core-switch small"><input v-model="form.controllerPanel" type="checkbox" :aria-label="t('core.dashboardLabel')" /><span class="core-switch-track" /></span>
          </label>
          <label class="listener-row">
            <span><b>{{ t('core.allowLan') }}</b><small>{{ t('core.allowLanHint') }}</small></span>
            <span class="core-switch small"><input v-model="form.allowLan" type="checkbox" :aria-label="t('core.allowLan')" /><span class="core-switch-track" /></span>
          </label>
        </div>
      </fieldset>

      <fieldset class="core-group">
        <legend>{{ t('common.enable') }}</legend>
        <label class="core-switch inline">
          <input v-model="form.enabled" type="checkbox" :aria-label="t('core.enableLabel')" />
          <span class="core-switch-track" />
          <span class="core-label">{{ t('core.enableHint') }}</span>
        </label>
      </fieldset>

      <fieldset class="core-group">
        <legend>{{ t('core.runtimeTitle') }}</legend>
        <div class="core-grid">
          <label class="core-field">
            <span class="core-label">{{ t('core.logLevel') }}</span>
            <AppSelect v-model="form.logLevel" :options="LOG_LEVEL_OPTIONS" :label="t('core.logLevel')" />
          </label>
          <label class="core-field">
            <span class="core-label">{{ t('core.processMode') }}</span>
            <AppSelect v-model="form.findProcessMode" :options="FIND_PROCESS_OPTIONS" :label="t('core.processModeLabel')" />
          </label>
          <label class="core-field">
            <span class="core-label">{{ t('core.interfaceName') }}</span>
            <AppSelect v-model="form.interfaceName" :options="INTERFACE_OPTIONS" :label="t('core.interfaceLabel')" />
          </label>
        </div>
      </fieldset>

      <fieldset class="core-group">
        <legend>{{ t('core.featureTitle') }}</legend>
        <div class="core-grid">
          <label class="core-switch small">
            <input v-model="form.ipv6" type="checkbox" aria-label="ipv6" />
            <span class="core-switch-track" />
            <span class="core-label">IPv6</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.tcpConcurrent" type="checkbox" aria-label="tcp-concurrent" />
            <span class="core-switch-track" />
            <span class="core-label">{{ t('core.tcpConcurrent') }}</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.unifiedDelay" type="checkbox" aria-label="unified-delay" />
            <span class="core-switch-track" />
            <span class="core-label">{{ t('core.unifiedDelay') }}</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.storeSelected" type="checkbox" aria-label="store-selected" />
            <span class="core-switch-track" />
            <span class="core-label">{{ t('core.storeSelected') }}</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.storeFakeIp" type="checkbox" aria-label="store-fake-ip" />
            <span class="core-switch-track" />
            <span class="core-label">{{ t('core.storeFakeIp') }}</span>
          </label>
        </div>
      </fieldset>

      <div class="core-actions">
        <button type="button" class="core-preview" @click="preview">{{ t('common.previewConfig') }}</button>
        <span v-if="dirty" class="unsaved-indicator">{{ t('common.unsaved') }}</span><button type="button" class="core-save" :disabled="store.busy || !dirty" @click="save">{{ store.busy ? t('common.saving') : t('common.save') }}</button>
      </div>

      <div v-if="previewOpen" class="core-preview">
        <div class="core-preview-head">
          <span>{{ t('core.previewTitle') }}</span>
          <button type="button" class="core-icon" :aria-label="t('common.closePreview')" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="core-preview-body">{{ previewYaml || t('common.emptyParen') }}</pre>
      </div>
      <ConfirmModal :open="resetOpen" :title="t('core.resetTitle')" :description="t('core.resetDescription')" :confirm-label="t('common.restoreDefaults')" :busy="store.busy" @close="resetOpen = false" @confirm="confirmReset" />
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
  gap: var(--space-5);
}
.core-title { margin: 0 0 4px; font-size: var(--font-size-lg); }
.core-subtitle { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; max-width: 560px; }
.core-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-panel);
  color: inherit;
  font-size: var(--font-size-sm);
  white-space: nowrap;
}
.core-head-actions { display: flex; align-items: center; gap: var(--space-3); flex: none; }
.core-body { margin-top: 14px; display: grid; gap: var(--space-6); }
.core-hint {
  margin: 0 0 0;
  padding: 0;
  color: var(--app-muted);
  font-size: var(--font-size-xs);
}
.core-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.core-group legend { padding: 0 6px; color: var(--app-muted); font-size: var(--font-size-xs); }
.listener-note { margin: 0 0 8px; color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.45; }
.listener-list { display: grid; }
.listener-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-7); min-height: 52px; border-bottom: 1px solid var(--app-divider); }
.listener-row:last-child { border-bottom: 0; }
.listener-row > span:first-child { display: grid; gap: var(--space-1); }
.listener-row b { color: var(--app-text); font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.listener-row small { color: var(--app-muted); font-size: var(--font-size-2xs); }
.port-input { width: 112px; text-align: right; font-variant-numeric: tabular-nums; }
.controller-address { display: grid; grid-template-columns: 160px 112px; align-items: center; gap: var(--space-2); }
.secret-field { position: relative; width: 280px; }
.secret-input { padding-right: 38px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.secret-eye { position: absolute; top: 50%; right: 5px; width: 28px; height: 28px; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--app-muted); }
.core-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); }
.core-field { display: grid; gap: var(--space-2); }
.core-label { color: var(--app-muted); font-size: var(--font-size-xs); }
.core-select,
.core-input {
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
}
.core-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.core-preview,
.core-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
}
.core-preview { background: var(--app-fill); color: inherit; }
.core-save { background: var(--app-blue); color: var(--app-on-accent); }
.core-save:disabled { opacity: 0.6; }
.core-switch { position: relative; display: inline-flex; align-items: center; gap: var(--space-3); cursor: pointer; }
.core-switch.inline { min-height: 34px; }
.core-switch.small { min-height: 34px; }
.core-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.core-switch-track {
  width: 34px;
  height: 20px;
  border-radius: var(--radius-md);
  background: var(--app-fill-strong);
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
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.core-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: var(--font-size-xs);
}
.core-icon {
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
.core-preview-body {
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
