<script setup lang="ts">
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
    { value: '', label: '自动选择' },
    ...[...names].map((name) => ({ value: name, label: name }))
  ]
})
const CONTROLLER_HOST_OPTIONS = [
  { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
  { value: '0.0.0.0', label: '0.0.0.0（所有网卡）' }
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
  if (ok) { syncFromConfig(store.settings); toast.success('内核设置已保存') }
  else toast.error('内核设置保存失败', store.lastError ?? undefined)
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
    toast.success('内核设置已恢复默认')
  } else toast.error('内核设置重置失败', store.lastError ?? undefined)
}

const dirty = computed(() => hydrated.value && JSON.stringify({ ...form }) !== JSON.stringify(store.settings))
useUnsavedChanges('core-settings', '内核设置', dirty)

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
  <section class="core-panel" aria-label="mihomo 核心设置">
    <header class="core-head">
      <div>
        <h2 class="core-title">内核运行设置</h2>
        <p class="core-subtitle">
          管理日志级别、IPv6、并发连接、延迟计算、进程识别、出站网卡和监听端口。启用后会覆盖配置文件中的对应设置。
        </p>
      </div>
      <div v-if="dirty" class="core-head-actions">
        <button type="button" class="core-reset" @click="restoreSaved">撤销更改</button>
        <button type="button" class="core-reset" @click="requestReset">恢复默认</button>
      </div>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <p v-if="!form.enabled" class="core-hint">
      当前未启用，将使用配置文件中的内核设置。
    </p>

    <div class="core-body">
      <fieldset class="core-group listener-group">
        <legend>监听与控制器</legend>
        <p class="listener-note">监听端口与控制器设置在下次重启应用后生效。端口请直接输入 1024–65535 之间且互不重复的数值。</p>
        <div class="listener-list">
          <label class="listener-row">
            <span><b>混合端口</b><small>系统代理与应用内部统一使用</small></span>
            <input v-model.number="form.mixedPort" class="core-input port-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="mixed-port" />
          </label>
          <label class="listener-row">
            <span><b>SOCKS 端口</b><small>独立 SOCKS5 入口</small></span>
            <input v-model.number="form.socksPort" class="core-input port-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="socks-port" />
          </label>
          <label class="listener-row">
            <span><b>HTTP 端口</b><small>独立 HTTP 代理入口</small></span>
            <input v-model.number="form.httpPort" class="core-input port-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="http-port" />
          </label>
          <label class="listener-row">
            <span><b>控制器监听</b><small>选择仅本机或所有网卡，再填写监听端口</small></span>
            <span class="controller-address"><AppSelect v-model="form.controllerHost" :options="CONTROLLER_HOST_OPTIONS" label="控制器监听地址" /><input v-model.number="form.controllerPort" class="core-input port-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="controller-port" /></span>
          </label>
          <label class="listener-row">
            <span><b>访问密钥</b><small>64 位小写十六进制字符；留空后下次启动会自动生成</small></span>
            <span class="secret-field"><input v-model.trim="form.controllerSecret" class="core-input secret-input" :type="secretVisible ? 'text' : 'password'" autocomplete="off" aria-label="访问密钥" /><button type="button" class="secret-eye" :aria-label="secretVisible ? '隐藏访问密钥' : '查看访问密钥'" @click.prevent="secretVisible = !secretVisible"><AppIcon name="eye" :size="16" /></button></span>
          </label>
          <label class="listener-row">
            <span><b>控制器面板</b><small>由 mihomo 下载并托管 MetaCubeXD 面板</small></span>
            <span class="core-switch small"><input v-model="form.controllerPanel" type="checkbox" aria-label="启用控制器面板" /><span class="core-switch-track" /></span>
          </label>
          <label class="listener-row">
            <span><b>允许局域网连接</b><small>允许局域网设备使用 HTTP、SOCKS 与混合端口</small></span>
            <span class="core-switch small"><input v-model="form.allowLan" type="checkbox" aria-label="允许局域网连接" /><span class="core-switch-track" /></span>
          </label>
        </div>
      </fieldset>

      <fieldset class="core-group">
        <legend>启用</legend>
        <label class="core-switch inline">
          <input v-model="form.enabled" type="checkbox" aria-label="启用核心设置覆盖" />
          <span class="core-switch-track" />
          <span class="core-label">启用后覆盖配置文件的同名核心参数</span>
        </label>
      </fieldset>

      <fieldset class="core-group">
        <legend>运行参数</legend>
        <div class="core-grid">
          <label class="core-field">
            <span class="core-label">日志级别</span>
            <AppSelect v-model="form.logLevel" :options="LOG_LEVEL_OPTIONS" label="日志级别" />
          </label>
          <label class="core-field">
            <span class="core-label">进程识别模式</span>
            <AppSelect v-model="form.findProcessMode" :options="FIND_PROCESS_OPTIONS" label="进程查找模式" />
          </label>
          <label class="core-field">
            <span class="core-label">出站网卡（留空自动选择）</span>
            <AppSelect v-model="form.interfaceName" :options="INTERFACE_OPTIONS" label="指定出站接口" />
          </label>
        </div>
      </fieldset>

      <fieldset class="core-group">
        <legend>特性开关</legend>
        <div class="core-grid">
          <label class="core-switch small">
            <input v-model="form.ipv6" type="checkbox" aria-label="ipv6" />
            <span class="core-switch-track" />
            <span class="core-label">IPv6</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.tcpConcurrent" type="checkbox" aria-label="tcp-concurrent" />
            <span class="core-switch-track" />
            <span class="core-label">TCP 并发</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.unifiedDelay" type="checkbox" aria-label="unified-delay" />
            <span class="core-switch-track" />
            <span class="core-label">使用 1-RTT 延迟测试</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.storeSelected" type="checkbox" aria-label="store-selected" />
            <span class="core-switch-track" />
            <span class="core-label">存储选择节点</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.storeFakeIp" type="checkbox" aria-label="store-fake-ip" />
            <span class="core-switch-track" />
            <span class="core-label">存储 FakeIP</span>
          </label>
        </div>
      </fieldset>

      <div class="core-actions">
        <button type="button" class="core-preview" @click="preview">预览配置</button>
        <span v-if="dirty" class="unsaved-indicator">未保存</span><button type="button" class="core-save" :disabled="store.busy || !dirty" @click="save">{{ store.busy ? '保存中…' : '保存' }}</button>
      </div>

      <div v-if="previewOpen" class="core-preview">
        <div class="core-preview-head">
          <span>将应用的内核运行配置</span>
          <button type="button" class="core-icon" aria-label="关闭预览" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="core-preview-body">{{ previewYaml || '（空）' }}</pre>
      </div>
      <ConfirmModal :open="resetOpen" title="恢复默认内核设置？" description="当前内核设置与默认值不同。确认后将保存默认设置；监听端口等需要重启应用后生效。" confirm-label="恢复默认" :busy="store.busy" @close="resetOpen = false" @confirm="confirmReset" />
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
  gap: 12px;
}
.core-title { margin: 0 0 4px; font-size: 15px; }
.core-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.core-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.core-head-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.core-body { margin-top: 14px; display: grid; gap: 14px; }
.core-hint {
  margin: 0 0 0;
  padding: 0;
  color: var(--app-muted);
  font-size: 11px;
}
.core-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.core-group legend { padding: 0 6px; color: var(--app-muted); font-size: 11px; }
.listener-note { margin: 0 0 8px; color: var(--app-muted); font-size: 10px; line-height: 1.45; }
.listener-list { display: grid; }
.listener-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 16px; min-height: 52px; border-bottom: 1px solid var(--app-divider); }
.listener-row:last-child { border-bottom: 0; }
.listener-row > span:first-child { display: grid; gap: 3px; }
.listener-row b { color: var(--app-text); font-size: 12px; font-weight: 600; }
.listener-row small { color: var(--app-muted); font-size: 10px; }
.port-input { width: 112px; text-align: right; font-variant-numeric: tabular-nums; }
.controller-address { display: grid; grid-template-columns: 160px 112px; align-items: center; gap: 6px; }
.secret-field { position: relative; width: 280px; }
.secret-input { padding-right: 38px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.secret-eye { position: absolute; top: 50%; right: 5px; width: 28px; height: 28px; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--app-muted); }
.core-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.core-field { display: grid; gap: 5px; }
.core-label { color: var(--app-muted); font-size: 11px; }
.core-select,
.core-input {
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  color: inherit;
  font-size: 12px;
}
.core-actions { display: flex; justify-content: flex-end; gap: 8px; }
.core-preview,
.core-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.core-preview { background: rgba(127, 127, 127, 0.14); color: inherit; }
.core-save { background: var(--app-blue); color: white; }
.core-save:disabled { opacity: 0.6; }
.core-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.core-switch.inline { min-height: 34px; }
.core-switch.small { min-height: 34px; }
.core-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.core-switch-track {
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.28);
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
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.core-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: 11px;
}
.core-icon {
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
.core-preview-body {
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
