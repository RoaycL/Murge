<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useTunConfigStore } from '../stores/tun-config'
import type { TunConfigModel } from '@shared/tun-config'
import AppSelect from './AppSelect.vue'
import AppIcon from './AppIcon.vue'

const store = useTunConfigStore()

const form = reactive<TunConfigModel>({
  stack: 'mixed',
  device: 'Mihomo',
  mtu: 9000,
  strictRoute: false,
  autoRoute: true,
  autoDetectInterface: true,
  dnsHijack: ['any:53'],
  routeAddress: [],
  routeExcludeAddress: []
})

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
  if (ok) syncFromConfig(store.config)
}

async function preview(): Promise<void> {
  previewYaml.value = await store.preview(buildInput())
  previewOpen.value = true
}

function resetFromStore(): void {
  syncFromConfig(store.config)
}

watch(
  () => store.config,
  (value) => syncFromConfig(value),
  { deep: true }
)

onMounted(async () => {
  await store.refresh()
  syncFromConfig(store.config)
})
</script>

<template>
  <section class="tun-panel" aria-label="TUN 配置模型">
    <header class="tun-head">
      <div>
        <h2 class="tun-title">TUN 配置模型</h2>
        <p class="tun-subtitle">
          为 mihomo 自营 TUN 适配器统一配置栈、设备、MTU、路由与 DNS 劫持等参数，无需改动订阅文件；启用 TUN 时由自营内核读取并合并，属于网络模式之间的独立配置。
        </p>
      </div>
      <button type="button" class="tun-reset" @click="resetFromStore">重置</button>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="tun-body">
      <fieldset class="tun-group">
        <legend>栈与设备</legend>
        <div class="tun-grid">
          <label class="tun-field">
            <span class="tun-label">stack</span>
            <AppSelect v-model="form.stack" :options="STACK_OPTIONS" label="TUN 栈" />
          </label>
          <label class="tun-field">
            <span class="tun-label">device（适配器标识）</span>
            <input v-model="form.device" class="tun-input" spellcheck="false" placeholder="Mihomo" />
          </label>
          <label class="tun-field">
            <span class="tun-label">mtu（576-65535）</span>
            <input v-model.number="form.mtu" class="tun-input" type="number" min="576" max="65535" />
          </label>
        </div>
      </fieldset>

      <fieldset class="tun-group">
        <legend>路由行为</legend>
        <div class="tun-grid">
          <label class="tun-switch small">
            <input v-model="form.autoRoute" type="checkbox" aria-label="auto-route" />
            <span class="tun-switch-track" />
            <span class="tun-label">auto-route</span>
          </label>
          <label class="tun-switch small">
            <input v-model="form.autoDetectInterface" type="checkbox" aria-label="auto-detect-interface" />
            <span class="tun-switch-track" />
            <span class="tun-label">auto-detect-interface</span>
          </label>
          <label class="tun-switch small">
            <input v-model="form.strictRoute" type="checkbox" aria-label="strict-route" />
            <span class="tun-switch-track" />
            <span class="tun-label">strict-route</span>
          </label>
        </div>
      </fieldset>

      <fieldset class="tun-group">
        <legend>DNS 劫持</legend>
        <div class="tun-grid">
          <label class="tun-field">
            <span class="tun-label">dns-hijack（每行一个：any、主机:端口、IP 或 [IPv6]:端口）</span>
            <textarea v-model="dnsHijackText" class="tun-textarea" spellcheck="false" placeholder="any:53" />
          </label>
        </div>
      </fieldset>

      <fieldset class="tun-group">
        <legend>路由地址</legend>
        <div class="tun-grid">
          <label class="tun-field">
            <span class="tun-label">route-address（每行一个 IP 或 CIDR）</span>
            <textarea v-model="routeAddressText" class="tun-textarea" spellcheck="false" placeholder="192.168.0.0/16" />
          </label>
          <label class="tun-field">
            <span class="tun-label">route-exclude-address（每行一个 IP 或 CIDR）</span>
            <textarea v-model="routeExcludeAddressText" class="tun-textarea" spellcheck="false" placeholder="10.0.0.0/8" />
          </label>
        </div>
      </fieldset>

      <div class="tun-actions">
        <button type="button" class="tun-preview" @click="preview">预览配置</button>
        <button type="button" class="tun-save" :disabled="store.busy" @click="save">保存</button>
      </div>

      <div v-if="previewOpen" class="tun-preview">
        <div class="tun-preview-head">
          <span>启用 TUN 时生效的 mihomo 配置</span>
          <button type="button" class="tun-icon" aria-label="关闭预览" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="tun-preview-body">{{ previewYaml || '（空）' }}</pre>
      </div>
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
  gap: 12px;
}
.tun-title { margin: 0 0 4px; font-size: 15px; }
.tun-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.tun-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.tun-body { margin-top: 14px; display: grid; gap: 14px; }
.tun-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.tun-group legend { padding: 0 6px; color: var(--app-muted); font-size: 11px; }
.tun-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.tun-field { display: grid; gap: 5px; }
.tun-label { color: var(--app-muted); font-size: 11px; }
.tun-input,
.tun-select {
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  color: inherit;
  font-size: 12px;
}
.tun-textarea {
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
.tun-actions { display: flex; justify-content: flex-end; gap: 8px; }
.tun-preview,
.tun-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.tun-preview { background: rgba(127, 127, 127, 0.14); color: inherit; }
.tun-save { background: var(--app-blue); color: white; }
.tun-save:disabled { opacity: 0.6; }
.tun-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.tun-switch.small { min-height: 34px; }
.tun-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.tun-switch-track {
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.28);
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
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.tun-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: 11px;
}
.tun-icon {
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
.tun-preview-body {
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
