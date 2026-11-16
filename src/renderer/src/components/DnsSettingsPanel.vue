<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import AppSelect from './AppSelect.vue'
import AppIcon from './AppIcon.vue'
import ConfirmModal from './ConfirmModal.vue'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { useDnsEnhancementStore } from '../stores/dns-enhancement'
import { EMPTY_DNS_ENHANCEMENT, type DnsEnhancement } from '@shared/dns'
import { plainJsonClone } from '@shared/plain-clone'

const store = useDnsEnhancementStore()
const toast = useToast()
const hydrated = ref(false)
const savedBaseline = ref('')
const resetOpen = ref(false)

const form = reactive<DnsEnhancement>({
  enabled: false,
  enhancedMode: 'fake-ip',
  ipv6: false,
  respectRules: false,
  fakeIpRange: '198.18.0.1/16',
  fakeIpFilterMode: 'blacklist',
  fakeIpFilter: [],
  useHosts: true,
  hosts: [],
  defaultNameserver: [],
  proxyServerNameserver: [],
  directNameserver: [],
  nameserver: [],
  fallback: [],
  nameserverPolicy: []
})

// Backing text for whitespace-separated list fields, so the owner edits them as
// plain lines instead of a fiddly array UI.
const fakeIpFilterText = ref('')
const hostsText = ref('')
const defaultNsText = ref('')
const proxyNsText = ref('')
const directNsText = ref('')
const nameserverText = ref('')
const fallbackText = ref('')
const policyText = ref('')

const previewYaml = ref('')
const previewOpen = ref(false)

function listToText(list: string[]): string {
  return list.join('\n')
}
function textToList(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}
function pairsToText(pairs: Array<{ domain: string; value: string }>): string {
  return pairs.map((pair) => `${pair.domain} ${pair.value}`).join('\n')
}
function textToPairs(text: string): Array<{ domain: string; value: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.search(/\s/)
      if (space < 0) return { domain: line, value: '' }
      return { domain: line.slice(0, space).trim(), value: line.slice(space).trim() }
    })
}

function syncFromEnhancement(value: DnsEnhancement): void {
  form.enabled = value.enabled
  form.enhancedMode = value.enhancedMode
  form.ipv6 = value.ipv6
  form.respectRules = value.respectRules
  form.fakeIpRange = value.fakeIpRange
  form.fakeIpFilterMode = value.fakeIpFilterMode
  form.fakeIpFilter = [...value.fakeIpFilter]
  form.hosts = value.hosts.map((entry) => ({ ...entry }))
  form.defaultNameserver = [...value.defaultNameserver]
  form.proxyServerNameserver = [...value.proxyServerNameserver]
  form.directNameserver = [...value.directNameserver]
  form.nameserver = [...value.nameserver]
  form.fallback = [...value.fallback]
  form.nameserverPolicy = value.nameserverPolicy.map((entry) => ({ ...entry }))

  fakeIpFilterText.value = listToText(value.fakeIpFilter)
  defaultNsText.value = listToText(value.defaultNameserver)
  proxyNsText.value = listToText(value.proxyServerNameserver)
  directNsText.value = listToText(value.directNameserver)
  nameserverText.value = listToText(value.nameserver)
  fallbackText.value = listToText(value.fallback)
  hostsText.value = pairsToText(value.hosts.map((entry) => ({ domain: entry.domain, value: entry.address })))
  policyText.value = pairsToText(value.nameserverPolicy.map((entry) => ({ domain: entry.domain, value: entry.server })))
}

function buildInput(): DnsEnhancement {
  const nameserver = textToList(nameserverText.value)
  let proxyServerNameserver = textToList(proxyNsText.value)
  // Mihomo requires a dedicated bootstrap resolver when DNS traffic follows
  // routing rules. Reuse the chosen resolvers when the owner has not supplied a
  // separate list, matching the safe defaults used by the reference clients.
  if (form.respectRules && proxyServerNameserver.length === 0) {
    proxyServerNameserver = [...nameserver]
  }
  return {
    ...form,
    fakeIpFilter: textToList(fakeIpFilterText.value),
    defaultNameserver: textToList(defaultNsText.value),
    proxyServerNameserver,
    directNameserver: textToList(directNsText.value),
    nameserver,
    fallback: textToList(fallbackText.value),
    hosts: textToPairs(hostsText.value).map((pair) => ({ domain: pair.domain, address: pair.value })),
    nameserverPolicy: textToPairs(policyText.value).map((pair) => ({ domain: pair.domain, server: pair.value }))
  }
}

function syncAndAccept(value: DnsEnhancement): void {
  syncFromEnhancement(value)
  savedBaseline.value = JSON.stringify(buildInput())
}

async function save(): Promise<void> {
  const ok = await store.save(buildInput())
  if (ok) { syncAndAccept(store.enhancement); toast.success(t('dns.saved')) }
  else toast.error(t('dns.saveFailed'), store.lastError ?? undefined)
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
  const ok = await store.save(plainJsonClone(EMPTY_DNS_ENHANCEMENT))
  if (ok) {
    syncAndAccept(store.enhancement)
    resetOpen.value = false
    toast.success(t('dns.resetDone'))
  } else toast.error(t('dns.resetFailed'), store.lastError ?? undefined)
}

const dirty = computed(() => hydrated.value && JSON.stringify(buildInput()) !== savedBaseline.value)
useUnsavedChanges('dns-enhancement', t('dns.name'), dirty)

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
  <section class="dns-panel" :aria-label="t('dns.title')">
    <header class="dns-head">
      <div>
        <h2 class="dns-title">{{ t('dns.title') }}</h2>
        <p class="dns-subtitle">
          {{ t('dns.intro') }}
        </p>
      </div>
      <div v-if="dirty" class="dns-head-actions"><button type="button" class="dns-reset" @click="restoreSaved">{{ t('common.revertChanges') }}</button><button type="button" class="dns-reset" @click="requestReset">{{ t('common.restoreDefaults') }}</button></div>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="dns-body">
      <div class="dns-row">
        <label class="dns-switch">
          <input v-model="form.enabled" type="checkbox" :aria-label="t('dns.enableLabel')" />
          <span class="dns-switch-track" />
          <span class="dns-label">{{ t('common.enable') }}</span>
        </label>
      </div>

      <fieldset class="dns-group">
        <legend>{{ t('dns.basic') }}</legend>
        <div class="dns-grid">
          <label class="dns-field">
            <span class="dns-label">{{ t('dns.enhancedMode') }}</span>
            <AppSelect v-model="form.enhancedMode" :options="[{ value: 'fake-ip', label: t('dns.fakeIp') }, { value: 'redir-host', label: t('dns.realIp') }]" :label="t('dns.enhancedModeLabel')" />
          </label>
          <label v-if="form.enhancedMode === 'fake-ip'" class="dns-field">
            <span class="dns-label">{{ t('dns.fakeIpRange') }}</span>
            <input v-model="form.fakeIpRange" class="dns-input" spellcheck="false" placeholder="198.18.0.1/16" />
          </label>
          <label v-if="form.enhancedMode === 'fake-ip'" class="dns-field">
            <span class="dns-label">{{ t('dns.fakeIpFilterMode') }}</span>
            <AppSelect v-model="form.fakeIpFilterMode" :options="[{ value: 'blacklist', label: t('dns.blacklist') }, { value: 'whitelist', label: t('dns.whitelist') }]" :label="t('dns.fakeIpFilterMode')" />
          </label>
          <label class="dns-switch small">
            <input v-model="form.ipv6" type="checkbox" :aria-label="t('dns.enableIpv6')" />
            <span class="dns-switch-track" />
            <span class="dns-label">IPv6</span>
          </label>
          <label class="dns-switch small">
            <input v-model="form.respectRules" type="checkbox" :aria-label="t('dns.respectRules')" />
            <span class="dns-switch-track" />
            <span class="dns-label">{{ t('dns.respectRules') }}</span>
          </label>
          <label class="dns-switch small">
            <input v-model="form.useHosts" type="checkbox" :aria-label="t('dns.useHosts')" />
            <span class="dns-switch-track" />
            <span class="dns-label">{{ t('dns.useHosts') }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset v-if="form.enhancedMode === 'fake-ip'" class="dns-group">
        <legend>{{ t('dns.fakeIpFilter') }}</legend>
        <p class="dns-group-hint">{{ t('dns.fakeIpFilterHint') }}</p>
        <label class="dns-field">
          <span class="dns-label">{{ t('dns.filterRules') }}</span>
          <textarea v-model="fakeIpFilterText" class="dns-textarea" spellcheck="false" placeholder="*.lan&#10;*.local&#10;local" />
        </label>
      </fieldset>

      <fieldset class="dns-group">
        <legend>{{ t('dns.servers') }}</legend>
        <p class="dns-group-hint">{{ t('dns.serversHint') }}</p>
        <div class="dns-grid">
          <label class="dns-field">
            <span class="dns-label">{{ t('dns.defaultNameserver') }}</span>
            <textarea v-model="defaultNsText" class="dns-textarea" spellcheck="false" placeholder="tls://223.5.5.5" />
          </label>
          <label class="dns-field">
            <span class="dns-label">{{ t('dns.nameserver') }}</span>
            <textarea v-model="nameserverText" class="dns-textarea" spellcheck="false" placeholder="https://doh.pub/dns-query" />
          </label>
          <label class="dns-field">
            <span class="dns-label">{{ t('dns.fallback') }}</span>
            <textarea v-model="fallbackText" class="dns-textarea" spellcheck="false" :placeholder="t('dns.fallbackPlaceholder')" />
          </label>
          <label class="dns-field">
            <span class="dns-label">{{ t('dns.proxyServerNameserver') }}</span>
            <textarea v-model="proxyNsText" class="dns-textarea" spellcheck="false" />
          </label>
          <label class="dns-field">
            <span class="dns-label">{{ t('dns.directNameserver') }}</span>
            <textarea v-model="directNsText" class="dns-textarea" spellcheck="false" />
          </label>
        </div>
      </fieldset>

      <fieldset class="dns-group">
        <legend>{{ t('dns.mapping') }}</legend>
        <p class="dns-group-hint">{{ t('dns.mappingHint') }}</p>
        <div class="dns-grid">
          <label class="dns-field">
            <span class="dns-label">{{ t('dns.hosts') }}</span>
            <textarea v-model="hostsText" class="dns-textarea" spellcheck="false" placeholder="example.com 1.2.3.4" />
          </label>
          <label class="dns-field">
            <span class="dns-label">{{ t('dns.nameserverPolicy') }}</span>
            <textarea v-model="policyText" class="dns-textarea" spellcheck="false" placeholder="geosite:cn 1.1.1.1" />
          </label>
        </div>
      </fieldset>

      <div class="dns-actions">
        <button type="button" class="dns-preview" @click="preview">{{ t('common.previewConfig') }}</button>
        <span v-if="dirty" class="unsaved-indicator">{{ t('common.unsaved') }}</span><button type="button" class="dns-save" :disabled="store.busy || !dirty" @click="save">{{ store.busy ? t('common.saving') : t('common.save') }}</button>
      </div>

      <div v-if="previewOpen" class="dns-preview">
        <div class="dns-preview-head">
          <span>{{ t('dns.previewTitle') }}</span>
          <button type="button" class="dns-icon" :aria-label="t('common.closePreview')" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="dns-preview-body">{{ previewYaml || t('common.emptyParen') }}</pre>
      </div>
      <ConfirmModal :open="resetOpen" :title="t('dns.resetTitle')" :description="t('dns.resetDescription')" :confirm-label="t('common.restoreDefaults')" :busy="store.busy" @close="resetOpen = false" @confirm="confirmReset" />
    </div>
  </section>
</template>

<style scoped>
.dns-panel {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
}
.dns-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
}
.dns-title { margin: 0 0 4px; font-size: var(--font-size-lg); }
.dns-subtitle { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; max-width: 560px; }
.dns-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-panel);
  color: inherit;
  font-size: var(--font-size-sm);
  white-space: nowrap;
}
.dns-head-actions { display: flex; align-items: center; gap: var(--space-3); flex: none; }
.dns-body { margin-top: 14px; display: grid; gap: var(--space-6); }
.dns-row { display: flex; align-items: center; gap: var(--space-4); }
.dns-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.dns-group legend { padding: 0 6px; color: var(--app-muted); font-size: var(--font-size-xs); }
.dns-group-hint { margin: 0 0 10px; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.45; }
.dns-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
.dns-field { display: grid; gap: var(--space-2); }
.dns-label { color: var(--app-muted); font-size: var(--font-size-xs); }
.dns-input {
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
}
.dns-input:focus { outline: 1px solid var(--app-blue); }
.dns-textarea {
  width: 100%;
  min-height: 88px;
  padding: 8px 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
.dns-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.dns-preview,
.dns-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
}
.dns-preview { background: var(--app-fill); color: inherit; }
.dns-save { background: var(--app-blue); color: var(--app-on-accent); }
.dns-save:disabled { opacity: 0.6; }
.dns-switch { position: relative; display: inline-flex; align-items: center; gap: var(--space-3); cursor: pointer; }
.dns-switch.small { min-height: 34px; }
.dns-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.dns-switch-track {
  width: 34px;
  height: 20px;
  border-radius: var(--radius-md);
  background: var(--app-fill-strong);
  position: relative;
  transition: background 0.15s ease;
  flex: none;
}
.dns-switch-track::after {
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
.dns-switch input:checked + .dns-switch-track { background: var(--app-blue); }
.dns-switch input:checked + .dns-switch-track::after { transform: translateX(14px); }
.dns-preview {
  display: grid;
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-md);
  background: var(--app-panel);
}
.dns-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: var(--font-size-xs);
}
.dns-icon {
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
.dns-preview-body {
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
