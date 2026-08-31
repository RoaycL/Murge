<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useDnsEnhancementStore } from '../stores/dns-enhancement'
import type { DnsEnhancement } from '@shared/dns'

const store = useDnsEnhancementStore()

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
  return {
    ...form,
    fakeIpFilter: textToList(fakeIpFilterText.value),
    defaultNameserver: textToList(defaultNsText.value),
    proxyServerNameserver: textToList(proxyNsText.value),
    directNameserver: textToList(directNsText.value),
    nameserver: textToList(nameserverText.value),
    fallback: textToList(fallbackText.value),
    hosts: textToPairs(hostsText.value).map((pair) => ({ domain: pair.domain, address: pair.value })),
    nameserverPolicy: textToPairs(policyText.value).map((pair) => ({ domain: pair.domain, server: pair.value }))
  }
}

async function save(): Promise<void> {
  const ok = await store.save(buildInput())
  if (ok) syncFromEnhancement(store.enhancement)
}

async function preview(): Promise<void> {
  previewYaml.value = await store.preview(buildInput())
  previewOpen.value = true
}

function resetFromStore(): void {
  syncFromEnhancement(store.enhancement)
}

watch(
  () => store.enhancement,
  (value) => syncFromEnhancement(value),
  { deep: true }
)

onMounted(async () => {
  await store.refresh()
  syncFromEnhancement(store.enhancement)
})
</script>

<template>
  <section class="dns-panel" aria-label="DNS 增强">
    <header class="dns-head">
      <div>
        <h2 class="dns-title">DNS 增强</h2>
        <p class="dns-subtitle">
          为所有订阅统一配置内核 DNS：增强模式、Fake-IP 范围与过滤、IPv6、nameserver / fallback / nameserver-policy 等，无需改动订阅文件；下次启动内核时生效。
        </p>
      </div>
      <button type="button" class="dns-reset" @click="resetFromStore">重置</button>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="dns-body">
      <div class="dns-row">
        <label class="dns-switch">
          <input v-model="form.enabled" type="checkbox" aria-label="启用 DNS 增强" />
          <span class="dns-switch-track" />
          <span class="dns-label">启用</span>
        </label>
      </div>

      <fieldset class="dns-group">
        <legend>基础</legend>
        <div class="dns-grid">
          <label class="dns-field">
            <span class="dns-label">增强模式</span>
            <select v-model="form.enhancedMode" class="dns-input">
              <option value="fake-ip">fake-ip</option>
              <option value="redir-host">redir-host</option>
              <option value="normal">normal</option>
            </select>
          </label>
          <label class="dns-field">
            <span class="dns-label">Fake-IP 范围</span>
            <input v-model="form.fakeIpRange" class="dns-input" spellcheck="false" placeholder="198.18.0.1/16" />
          </label>
          <label class="dns-field">
            <span class="dns-label">Fake-IP 过滤模式</span>
            <select v-model="form.fakeIpFilterMode" class="dns-input">
              <option value="blacklist">blacklist</option>
              <option value="whitelist">whitelist</option>
            </select>
          </label>
          <label class="dns-switch small">
            <input v-model="form.ipv6" type="checkbox" aria-label="启用 IPv6" />
            <span class="dns-switch-track" />
            <span class="dns-label">IPv6</span>
          </label>
          <label class="dns-switch small">
            <input v-model="form.respectRules" type="checkbox" aria-label="遵循规则" />
            <span class="dns-switch-track" />
            <span class="dns-label">遵循规则</span>
          </label>
          <label class="dns-switch small">
            <input v-model="form.useHosts" type="checkbox" aria-label="使用 hosts" />
            <span class="dns-switch-track" />
            <span class="dns-label">使用 hosts</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="dns-group">
        <legend>Fake-IP 过滤</legend>
        <label class="dns-field">
          <span class="dns-label">过滤规则（每行一个，支持域名、*. 通配符或 geosite:/geoip: 规则）</span>
          <textarea v-model="fakeIpFilterText" class="dns-textarea" spellcheck="false" placeholder="*.lan&#10;*.local&#10;local" />
        </label>
      </fieldset>

      <fieldset class="dns-group">
        <legend>Nameserver</legend>
        <div class="dns-grid">
          <label class="dns-field">
            <span class="dns-label">default-nameserver（每行一个）</span>
            <textarea v-model="defaultNsText" class="dns-textarea" spellcheck="false" placeholder="1.1.1.1&#10;8.8.8.8" />
          </label>
          <label class="dns-field">
            <span class="dns-label">nameserver（每行一个）</span>
            <textarea v-model="nameserverText" class="dns-textarea" spellcheck="false" placeholder="https://1.1.1.1/dns-query" />
          </label>
          <label class="dns-field">
            <span class="dns-label">fallback（每行一个）</span>
            <textarea v-model="fallbackText" class="dns-textarea" spellcheck="false" placeholder="tls://8.8.8.8:853" />
          </label>
          <label class="dns-field">
            <span class="dns-label">proxy-server-nameserver（可选，每行一个）</span>
            <textarea v-model="proxyNsText" class="dns-textarea" spellcheck="false" />
          </label>
          <label class="dns-field">
            <span class="dns-label">direct-nameserver（可选，每行一个）</span>
            <textarea v-model="directNsText" class="dns-textarea" spellcheck="false" />
          </label>
        </div>
      </fieldset>

      <fieldset class="dns-group">
        <legend>映射</legend>
        <div class="dns-grid">
          <label class="dns-field">
            <span class="dns-label">hosts（每行：域名 IP）</span>
            <textarea v-model="hostsText" class="dns-textarea" spellcheck="false" placeholder="example.com 1.2.3.4" />
          </label>
          <label class="dns-field">
            <span class="dns-label">nameserver-policy（每行：域名规则 服务器）</span>
            <textarea v-model="policyText" class="dns-textarea" spellcheck="false" placeholder="geosite:cn 1.1.1.1" />
          </label>
        </div>
      </fieldset>

      <div class="dns-actions">
        <button type="button" class="dns-preview" @click="preview">预览配置</button>
        <button type="button" class="dns-save" :disabled="store.busy" @click="save">保存</button>
      </div>

      <div v-if="previewOpen" class="dns-preview">
        <div class="dns-preview-head">
          <span>生效的内核 DNS 配置（敏感信息已隐藏）</span>
          <button type="button" class="dns-icon" aria-label="关闭预览" @click="previewOpen = false">✕</button>
        </div>
        <pre class="dns-preview-body">{{ previewYaml || '（空）' }}</pre>
      </div>
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
  gap: 12px;
}
.dns-title { margin: 0 0 4px; font-size: 15px; }
.dns-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.dns-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.dns-body { margin-top: 14px; display: grid; gap: 14px; }
.dns-row { display: flex; align-items: center; gap: 10px; }
.dns-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.dns-group legend { padding: 0 6px; color: var(--app-muted); font-size: 11px; }
.dns-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.dns-field { display: grid; gap: 5px; }
.dns-label { color: var(--app-muted); font-size: 11px; }
.dns-input {
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  color: inherit;
  font-size: 12px;
}
.dns-input:focus { outline: 1px solid var(--app-blue); }
.dns-textarea {
  width: 100%;
  min-height: 88px;
  padding: 8px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  color: inherit;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
.dns-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dns-preview,
.dns-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.dns-preview { background: rgba(127, 127, 127, 0.14); color: inherit; }
.dns-save { background: var(--app-blue); color: white; }
.dns-save:disabled { opacity: 0.6; }
.dns-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.dns-switch.small { min-height: 34px; }
.dns-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.dns-switch-track {
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.28);
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
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.dns-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: 11px;
}
.dns-icon {
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
.dns-preview-body {
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
