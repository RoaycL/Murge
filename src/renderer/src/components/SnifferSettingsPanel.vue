<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useSnifferEnhancementStore } from '../stores/sniffer-enhancement'
import type { SnifferEnhancement } from '@shared/sniffer'
import AppIcon from './AppIcon.vue'
import { useToast } from '../composables/use-toast'

const store = useSnifferEnhancementStore()
const toast = useToast()

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

async function save(): Promise<void> {
  const ok = await store.save(buildInput())
  if (ok) { syncFromEnhancement(store.enhancement); toast.success('嗅探设置已保存') }
  else toast.error('嗅探设置保存失败', store.lastError ?? undefined)
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
  <section class="sniffer-panel" aria-label="Sniffer 增强">
    <header class="sniffer-head">
      <div>
        <h2 class="sniffer-title">Sniffer 增强</h2>
        <p class="sniffer-subtitle">
          为所有订阅统一配置内核嗅探：启用/覆盖目标、HTTP / TLS / QUIC 端口、跳过与强制域名、源/目的地址白名单等，无需改动订阅文件；下次启动内核时生效。
        </p>
      </div>
      <button type="button" class="sniffer-reset" @click="resetFromStore">重置</button>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="sniffer-body">
      <div class="sniffer-row">
        <label class="sniffer-switch">
          <input v-model="form.enabled" type="checkbox" aria-label="启用 Sniffer 增强" />
          <span class="sniffer-switch-track" />
          <span class="sniffer-label">启用</span>
        </label>
      </div>

      <fieldset class="sniffer-group">
        <legend>行为</legend>
        <div class="sniffer-grid">
          <label class="sniffer-switch small">
            <input v-model="form.overrideDestination" type="checkbox" aria-label="覆盖目标地址" />
            <span class="sniffer-switch-track" />
            <span class="sniffer-label">override-destination</span>
          </label>
          <label class="sniffer-switch small">
            <input v-model="form.forceDnsMapping" type="checkbox" aria-label="强制 DNS 映射" />
            <span class="sniffer-switch-track" />
            <span class="sniffer-label">force-dns-mapping</span>
          </label>
          <label class="sniffer-switch small">
            <input v-model="form.parsePureIp" type="checkbox" aria-label="解析纯 IP 流" />
            <span class="sniffer-switch-track" />
            <span class="sniffer-label">parse-pure-ip</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="sniffer-group">
        <legend>端口范围</legend>
        <div class="sniffer-grid">
          <label class="sniffer-field">
            <span class="sniffer-label">HTTP（每行一个端口、范围或 *）</span>
            <textarea v-model="httpPortsText" class="sniffer-textarea" spellcheck="false" placeholder="80&#10;8080-8880" />
          </label>
          <label class="sniffer-field">
            <span class="sniffer-label">TLS（每行一个端口、范围或 *）</span>
            <textarea v-model="tlsPortsText" class="sniffer-textarea" spellcheck="false" placeholder="443&#10;8443" />
          </label>
          <label class="sniffer-field">
            <span class="sniffer-label">QUIC（每行一个端口、范围或 *）</span>
            <textarea v-model="quicPortsText" class="sniffer-textarea" spellcheck="false" placeholder="443" />
          </label>
        </div>
      </fieldset>

      <fieldset class="sniffer-group">
        <legend>域名</legend>
        <div class="sniffer-grid">
          <label class="sniffer-field">
            <span class="sniffer-label">skip-domain（每行一个，支持域名、*. 通配符或 geosite:/geoip: 规则）</span>
            <textarea v-model="skipDomainText" class="sniffer-textarea" spellcheck="false" placeholder="*.apple.com&#10;Mijia Cloud" />
          </label>
          <label class="sniffer-field">
            <span class="sniffer-label">force-domain（每行一个）</span>
            <textarea v-model="forceDomainText" class="sniffer-textarea" spellcheck="false" placeholder="dns.alidns.com" />
          </label>
        </div>
      </fieldset>

      <fieldset class="sniffer-group">
        <legend>地址</legend>
        <div class="sniffer-grid">
          <label class="sniffer-field">
            <span class="sniffer-label">skip-src-address（每行一个 IP 或 CIDR）</span>
            <textarea v-model="skipSrcText" class="sniffer-textarea" spellcheck="false" placeholder="127.0.0.1/8&#10;::1/128" />
          </label>
          <label class="sniffer-field">
            <span class="sniffer-label">skip-dst-address（每行一个 IP 或 CIDR）</span>
            <textarea v-model="skipDstText" class="sniffer-textarea" spellcheck="false" placeholder="127.0.0.1/8&#10;::1/128" />
          </label>
        </div>
      </fieldset>

      <div class="sniffer-actions">
        <button type="button" class="sniffer-preview" @click="preview">预览配置</button>
        <button type="button" class="sniffer-save" :disabled="store.busy" @click="save">{{ store.busy ? '保存中…' : '保存' }}</button>
      </div>

      <div v-if="previewOpen" class="sniffer-preview">
        <div class="sniffer-preview-head">
          <span>生效的内核 Sniffer 配置</span>
          <button type="button" class="sniffer-icon" aria-label="关闭预览" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="sniffer-preview-body">{{ previewYaml || '（空）' }}</pre>
      </div>
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
  gap: 12px;
}
.sniffer-title { margin: 0 0 4px; font-size: 15px; }
.sniffer-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.sniffer-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.sniffer-body { margin-top: 14px; display: grid; gap: 14px; }
.sniffer-row { display: flex; align-items: center; gap: 10px; }
.sniffer-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.sniffer-group legend { padding: 0 6px; color: var(--app-muted); font-size: 11px; }
.sniffer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.sniffer-field { display: grid; gap: 5px; }
.sniffer-label { color: var(--app-muted); font-size: 11px; }
.sniffer-textarea {
  width: 100%;
  min-height: 72px;
  padding: 8px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  color: inherit;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
.sniffer-actions { display: flex; justify-content: flex-end; gap: 8px; }
.sniffer-preview,
.sniffer-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.sniffer-preview { background: rgba(127, 127, 127, 0.14); color: inherit; }
.sniffer-save { background: var(--app-blue); color: white; }
.sniffer-save:disabled { opacity: 0.6; }
.sniffer-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.sniffer-switch.small { min-height: 34px; }
.sniffer-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.sniffer-switch-track {
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.28);
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
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.sniffer-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: 11px;
}
.sniffer-icon {
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
.sniffer-preview-body {
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
