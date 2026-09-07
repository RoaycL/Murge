<script setup lang="ts">
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
  if (ok) { syncAndAccept(store.enhancement); toast.success('DNS 设置已保存') }
  else toast.error('DNS 设置保存失败', store.lastError ?? undefined)
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
    toast.success('DNS 设置已恢复默认并生效')
  } else toast.error('DNS 设置重置失败', store.lastError ?? undefined)
}

const dirty = computed(() => hydrated.value && JSON.stringify(buildInput()) !== savedBaseline.value)
useUnsavedChanges('dns-enhancement', 'DNS 设置', dirty)

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
  <section class="dns-panel" aria-label="DNS 增强">
    <header class="dns-head">
      <div>
        <h2 class="dns-title">DNS 增强</h2>
        <p class="dns-subtitle">
          为所有订阅统一配置内核 DNS：解析模式、虚拟 IP 范围、服务器与域名分流，无需改动订阅文件；保存后立即应用。
        </p>
      </div>
      <div v-if="dirty" class="dns-head-actions"><button type="button" class="dns-reset" @click="restoreSaved">撤销更改</button><button type="button" class="dns-reset" @click="requestReset">恢复默认</button></div>
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
            <AppSelect v-model="form.enhancedMode" :options="[{ value: 'fake-ip', label: '虚拟 IP' }, { value: 'redir-host', label: '真实地址' }]" label="DNS 增强模式" />
          </label>
          <label v-if="form.enhancedMode === 'fake-ip'" class="dns-field">
            <span class="dns-label">虚拟 IP 地址范围</span>
            <input v-model="form.fakeIpRange" class="dns-input" spellcheck="false" placeholder="198.18.0.1/16" />
          </label>
          <label v-if="form.enhancedMode === 'fake-ip'" class="dns-field">
            <span class="dns-label">虚拟 IP 过滤模式</span>
            <AppSelect v-model="form.fakeIpFilterMode" :options="[{ value: 'blacklist', label: '排除匹配项' }, { value: 'whitelist', label: '仅包含匹配项' }]" label="虚拟 IP 过滤模式" />
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
            <input v-model="form.useHosts" type="checkbox" aria-label="使用静态域名映射" />
            <span class="dns-switch-track" />
            <span class="dns-label">使用静态域名映射</span>
          </label>
        </div>
      </fieldset>

      <fieldset v-if="form.enhancedMode === 'fake-ip'" class="dns-group">
        <legend>虚拟 IP 过滤</legend>
        <p class="dns-group-hint">每行填写一条规则，支持域名、通配符以及 geosite:/geoip: 规则。</p>
        <label class="dns-field">
          <span class="dns-label">过滤规则</span>
          <textarea v-model="fakeIpFilterText" class="dns-textarea" spellcheck="false" placeholder="*.lan&#10;*.local&#10;local" />
        </label>
      </fieldset>

      <fieldset class="dns-group">
        <legend>DNS 服务器</legend>
        <p class="dns-group-hint">下列输入框均每行填写一个服务器地址；可使用 IP、DoH、DoT、QUIC 或 DHCP 地址。</p>
        <div class="dns-grid">
          <label class="dns-field">
            <span class="dns-label">默认解析服务器</span>
            <textarea v-model="defaultNsText" class="dns-textarea" spellcheck="false" placeholder="tls://223.5.5.5" />
          </label>
          <label class="dns-field">
            <span class="dns-label">常规解析服务器</span>
            <textarea v-model="nameserverText" class="dns-textarea" spellcheck="false" placeholder="https://doh.pub/dns-query" />
          </label>
          <label class="dns-field">
            <span class="dns-label">备用解析服务器</span>
            <textarea v-model="fallbackText" class="dns-textarea" spellcheck="false" placeholder="留空则不启用备用解析" />
          </label>
          <label class="dns-field">
            <span class="dns-label">代理节点解析服务器（可选）</span>
            <textarea v-model="proxyNsText" class="dns-textarea" spellcheck="false" />
          </label>
          <label class="dns-field">
            <span class="dns-label">直连解析服务器（可选）</span>
            <textarea v-model="directNsText" class="dns-textarea" spellcheck="false" />
          </label>
        </div>
      </fieldset>

      <fieldset class="dns-group">
        <legend>映射</legend>
        <p class="dns-group-hint">每行填写一组“匹配内容 目标值”，内容与目标值之间使用空格分隔。</p>
        <div class="dns-grid">
          <label class="dns-field">
            <span class="dns-label">静态域名映射（域名 IP）</span>
            <textarea v-model="hostsText" class="dns-textarea" spellcheck="false" placeholder="example.com 1.2.3.4" />
          </label>
          <label class="dns-field">
            <span class="dns-label">域名分流策略（域名规则 服务器）</span>
            <textarea v-model="policyText" class="dns-textarea" spellcheck="false" placeholder="geosite:cn 1.1.1.1" />
          </label>
        </div>
      </fieldset>

      <div class="dns-actions">
        <button type="button" class="dns-preview" @click="preview">预览配置</button>
        <span v-if="dirty" class="unsaved-indicator">未保存</span><button type="button" class="dns-save" :disabled="store.busy || !dirty" @click="save">{{ store.busy ? '保存中…' : '保存' }}</button>
      </div>

      <div v-if="previewOpen" class="dns-preview">
        <div class="dns-preview-head">
          <span>生效的内核 DNS 配置（敏感信息已隐藏）</span>
          <button type="button" class="dns-icon" aria-label="关闭预览" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="dns-preview-body">{{ previewYaml || '（空）' }}</pre>
      </div>
      <ConfirmModal :open="resetOpen" title="恢复默认 DNS 设置？" description="当前 DNS 设置与默认值不同。确认后将保存默认设置，并立即应用到正在运行的内核。" confirm-label="恢复默认" :busy="store.busy" @close="resetOpen = false" @confirm="confirmReset" />
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
.dns-head-actions { display: flex; align-items: center; gap: 8px; flex: none; }
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
.dns-group-hint { margin: 0 0 10px; color: var(--app-muted); font-size: 11px; line-height: 1.45; }
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
