<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useSnifferEnhancementStore } from '../stores/sniffer-enhancement'
import type { SnifferEnhancement } from '@shared/sniffer'
import AppIcon from './AppIcon.vue'
import ConfirmModal from './ConfirmModal.vue'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { EMPTY_SNIFFER_ENHANCEMENT } from '@shared/sniffer'
import { plainJsonClone } from '@shared/plain-clone'

const store = useSnifferEnhancementStore()
const toast = useToast()
const hydrated = ref(false)
const savedBaseline = ref('')
const resetOpen = ref(false)

const form = reactive<SnifferEnhancement>({
  enabled: false,
  overrideDestination: true,
  forceDnsMapping: true,
  parsePureIp: true,
  ports: { http: [], tls: [], quic: [] },
  skipDomain: [],
  forceDomain: [],
  skipSrcAddress: [],
  skipDstAddress: []
})

// Whitespace-separated list fields are edited as plain lines.
const httpPortsText = ref('')
const tlsPortsText = ref('')
const quicPortsText = ref('')
const skipDomainText = ref('')
const forceDomainText = ref('')
const skipSrcText = ref('')
const skipDstText = ref('')

const previewYaml = ref('')
const previewOpen = ref(false)

function listToText(list: string[]): string {
  return list.join('\n')
}
function textToList(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

function syncFromEnhancement(value: SnifferEnhancement): void {
  form.enabled = value.enabled
  form.overrideDestination = value.overrideDestination
  form.forceDnsMapping = value.forceDnsMapping
  form.parsePureIp = value.parsePureIp
  form.ports = { http: [...value.ports.http], tls: [...value.ports.tls], quic: [...value.ports.quic] }
  form.skipDomain = [...value.skipDomain]
  form.forceDomain = [...value.forceDomain]
  form.skipSrcAddress = [...value.skipSrcAddress]
  form.skipDstAddress = [...value.skipDstAddress]

  httpPortsText.value = listToText(value.ports.http)
  tlsPortsText.value = listToText(value.ports.tls)
  quicPortsText.value = listToText(value.ports.quic)
  skipDomainText.value = listToText(value.skipDomain)
  forceDomainText.value = listToText(value.forceDomain)
  skipSrcText.value = listToText(value.skipSrcAddress)
  skipDstText.value = listToText(value.skipDstAddress)
}

function buildInput(): SnifferEnhancement {
  return {
    ...form,
    ports: {
      http: textToList(httpPortsText.value),
      tls: textToList(tlsPortsText.value),
      quic: textToList(quicPortsText.value)
    },
    skipDomain: textToList(skipDomainText.value),
    forceDomain: textToList(forceDomainText.value),
    skipSrcAddress: textToList(skipSrcText.value),
    skipDstAddress: textToList(skipDstText.value)
  }
}

function syncAndAccept(value: SnifferEnhancement): void {
  syncFromEnhancement(value)
  savedBaseline.value = JSON.stringify(buildInput())
}

async function save(): Promise<void> {
  const ok = await store.save(buildInput())
  if (ok) { syncAndAccept(store.enhancement); toast.success(t('sniffer.saved')) }
  else toast.error(t('sniffer.saveFailed'), store.lastError ?? undefined)
}

async function preview(): Promise<void> {
  previewYaml.value = await store.preview(buildInput())
  previewOpen.value = true
}

function requestReset(): void {
  resetOpen.value = true
}
function restoreSaved(): void { syncAndAccept(store.enhancement) }

async function confirmReset(): Promise<void> {
  const ok = await store.save(plainJsonClone(EMPTY_SNIFFER_ENHANCEMENT))
  if (ok) {
    syncAndAccept(store.enhancement)
    resetOpen.value = false
    toast.success(t('sniffer.resetDone'))
  } else toast.error(t('sniffer.resetFailed'), store.lastError ?? undefined)
}

const dirty = computed(() => hydrated.value && JSON.stringify(buildInput()) !== savedBaseline.value)
useUnsavedChanges('sniffer-enhancement', t('sniffer.name'), dirty)

watch(
  () => store.enhancement,
  (value) => syncAndAccept(value),
  { deep: true }
)

onMounted(async () => {
  await store.refresh()
  syncAndAccept(store.enhancement)
  hydrated.value = true
})
</script>

<template>
  <section class="sniffer-panel" :aria-label="t('sniffer.title')">
    <header class="sniffer-head">
      <div>
        <h2 class="sniffer-title">{{ t('sniffer.title') }}</h2>
        <p class="sniffer-subtitle">
          {{ t('sniffer.intro') }}
        </p>
      </div>
      <div v-if="dirty" class="sniffer-head-actions"><button type="button" class="sniffer-reset" @click="restoreSaved">{{ t('common.revertChanges') }}</button><button type="button" class="sniffer-reset" @click="requestReset">{{ t('common.restoreDefaults') }}</button></div>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="sniffer-body">
      <div class="sniffer-row">
        <label class="sniffer-switch">
          <input v-model="form.enabled" type="checkbox" :aria-label="t('sniffer.enableLabel')" />
          <span class="sniffer-switch-track" />
          <span class="sniffer-label">{{ t('common.enable') }}</span>
        </label>
      </div>

      <fieldset class="sniffer-group">
        <legend>{{ t('sniffer.behavior') }}</legend>
        <div class="sniffer-grid">
          <label class="sniffer-switch small">
            <input v-model="form.overrideDestination" type="checkbox" :aria-label="t('sniffer.overrideDestination')" />
            <span class="sniffer-switch-track" />
            <span class="sniffer-label">{{ t('sniffer.overrideDestination') }}</span>
          </label>
          <label class="sniffer-switch small">
            <input v-model="form.forceDnsMapping" type="checkbox" :aria-label="t('sniffer.forceDnsMappingLabel')" />
            <span class="sniffer-switch-track" />
            <span class="sniffer-label">{{ t('sniffer.forceDnsMapping') }}</span>
          </label>
          <label class="sniffer-switch small">
            <input v-model="form.parsePureIp" type="checkbox" :aria-label="t('sniffer.parsePureIpLabel')" />
            <span class="sniffer-switch-track" />
            <span class="sniffer-label">{{ t('sniffer.parsePureIp') }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="sniffer-group">
        <legend>{{ t('sniffer.portRanges') }}</legend>
        <p class="sniffer-group-hint">{{ t('sniffer.portRangesHint') }}</p>
        <div class="sniffer-grid">
          <label class="sniffer-field">
            <span class="sniffer-label">HTTP</span>
            <textarea v-model="httpPortsText" class="sniffer-textarea" spellcheck="false" placeholder="80&#10;443" />
          </label>
          <label class="sniffer-field">
            <span class="sniffer-label">TLS</span>
            <textarea v-model="tlsPortsText" class="sniffer-textarea" spellcheck="false" placeholder="443" />
          </label>
          <label class="sniffer-field">
            <span class="sniffer-label">QUIC</span>
            <textarea v-model="quicPortsText" class="sniffer-textarea" spellcheck="false" placeholder="443" />
          </label>
        </div>
      </fieldset>

      <fieldset class="sniffer-group">
        <legend>{{ t('sniffer.domains') }}</legend>
        <p class="sniffer-group-hint">{{ t('dns.fakeIpFilterHint') }}</p>
        <div class="sniffer-grid">
          <label class="sniffer-field">
            <span class="sniffer-label">{{ t('sniffer.skipDomain') }}</span>
            <textarea v-model="skipDomainText" class="sniffer-textarea" spellcheck="false" placeholder="*.apple.com&#10;Mijia Cloud" />
          </label>
          <label class="sniffer-field">
            <span class="sniffer-label">{{ t('sniffer.forceDomain') }}</span>
            <textarea v-model="forceDomainText" class="sniffer-textarea" spellcheck="false" placeholder="dns.alidns.com" />
          </label>
        </div>
      </fieldset>

      <fieldset class="sniffer-group">
        <legend>{{ t('sniffer.addresses') }}</legend>
        <p class="sniffer-group-hint">{{ t('sniffer.addressesHint') }}</p>
        <div class="sniffer-grid">
          <label class="sniffer-field">
            <span class="sniffer-label">{{ t('sniffer.skipSrc') }}</span>
            <textarea v-model="skipSrcText" class="sniffer-textarea" spellcheck="false" placeholder="127.0.0.1/8&#10;::1/128" />
          </label>
          <label class="sniffer-field">
            <span class="sniffer-label">{{ t('sniffer.skipDst') }}</span>
            <textarea v-model="skipDstText" class="sniffer-textarea" spellcheck="false" placeholder="127.0.0.1/8&#10;::1/128" />
          </label>
        </div>
      </fieldset>

      <div class="sniffer-actions">
        <button type="button" class="sniffer-preview" @click="preview">{{ t('common.previewConfig') }}</button>
        <span v-if="dirty" class="unsaved-indicator">{{ t('common.unsaved') }}</span><button type="button" class="sniffer-save" :disabled="store.busy || !dirty" @click="save">{{ store.busy ? t('common.saving') : t('common.save') }}</button>
      </div>

      <div v-if="previewOpen" class="sniffer-preview">
        <div class="sniffer-preview-head">
          <span>{{ t('sniffer.previewTitle') }}</span>
          <button type="button" class="sniffer-icon" :aria-label="t('common.closePreview')" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="sniffer-preview-body">{{ previewYaml || t('common.emptyParen') }}</pre>
      </div>
      <ConfirmModal :open="resetOpen" :title="t('sniffer.resetTitle')" :description="t('sniffer.resetDescription')" :confirm-label="t('common.restoreDefaults')" :busy="store.busy" @close="resetOpen = false" @confirm="confirmReset" />
    </div>
  </section>
</template>

<style scoped>
.sniffer-panel {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
}
.sniffer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
}
.sniffer-title { margin: 0 0 4px; font-size: var(--font-size-lg); }
.sniffer-subtitle { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; max-width: 560px; }
.sniffer-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-panel);
  color: inherit;
  font-size: var(--font-size-sm);
  white-space: nowrap;
}
.sniffer-head-actions { display: flex; align-items: center; gap: var(--space-3); flex: none; }
.sniffer-body { margin-top: 14px; display: grid; gap: var(--space-6); }
.sniffer-row { display: flex; align-items: center; gap: var(--space-4); }
.sniffer-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.sniffer-group legend { padding: 0 6px; color: var(--app-muted); font-size: var(--font-size-xs); }
.sniffer-group-hint { margin: 0 0 10px; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.45; }
.sniffer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
.sniffer-field { display: grid; gap: var(--space-2); }
.sniffer-label { color: var(--app-muted); font-size: var(--font-size-xs); }
.sniffer-textarea {
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
.sniffer-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.sniffer-preview,
.sniffer-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
}
.sniffer-preview { background: var(--app-fill); color: inherit; }
.sniffer-save { background: var(--app-blue); color: var(--app-on-accent); }
.sniffer-save:disabled { opacity: 0.6; }
.sniffer-switch { position: relative; display: inline-flex; align-items: center; gap: var(--space-3); cursor: pointer; }
.sniffer-switch.small { min-height: 34px; }
.sniffer-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.sniffer-switch-track {
  width: 34px;
  height: 20px;
  border-radius: var(--radius-md);
  background: var(--app-fill-strong);
  position: relative;
  transition: background 0.15s ease;
  flex: none;
}
.sniffer-switch-track::after {
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
.sniffer-switch input:checked + .sniffer-switch-track { background: var(--app-blue); }
.sniffer-switch input:checked + .sniffer-switch-track::after { transform: translateX(14px); }
.sniffer-preview {
  display: grid;
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.sniffer-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: var(--font-size-xs);
}
.sniffer-icon {
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
.sniffer-preview-body {
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
