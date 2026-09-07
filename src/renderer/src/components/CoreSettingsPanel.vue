<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useCoreSettingsStore } from '../stores/core-settings'
import type { CoreSettings } from '@shared/core-settings'
import { EMPTY_CORE_SETTINGS } from '@shared/core-settings'
import AppSelect from './AppSelect.vue'
import AppIcon from './AppIcon.vue'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'

const store = useCoreSettingsStore()
const toast = useToast()
const hydrated = ref(false)
const networkInterfaces = ref<string[]>([])

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

function syncFromConfig(value: CoreSettings): void {
  form.enabled = value.enabled
  form.logLevel = value.logLevel
  form.ipv6 = value.ipv6
  form.tcpConcurrent = value.tcpConcurrent
  form.unifiedDelay = value.unifiedDelay
  form.findProcessMode = value.findProcessMode
  form.interfaceName = value.interfaceName
  form.mixedPort = value.mixedPort
  form.socksPort = value.socksPort
  form.httpPort = value.httpPort
  form.controllerPort = value.controllerPort
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

function resetFromStore(): void {
  syncFromConfig(store.settings)
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
      <button type="button" class="core-reset" @click="resetFromStore">重置</button>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <p v-if="!form.enabled" class="core-hint">
      当前未启用，将使用配置文件中的内核设置。
    </p>

    <div class="core-body">
      <fieldset class="core-group listener-group">
        <legend>监听与控制器</legend>
        <p class="listener-note">端口在下次重启应用后生效；0 表示关闭独立 HTTP/SOCKS 入站。所有入口仍只监听本机。</p>
        <div class="listener-list">
          <label class="listener-row">
            <span><b>混合端口</b><small>系统代理与应用内部统一使用</small></span>
            <input v-model.number="form.mixedPort" class="core-input port-input" type="number" min="1024" max="65535" aria-label="mixed-port" />
          </label>
          <label class="listener-row">
            <span><b>SOCKS 端口</b><small>可选独立 SOCKS5 入口</small></span>
            <input v-model.number="form.socksPort" class="core-input port-input" type="number" min="0" max="65535" aria-label="socks-port" />
          </label>
          <label class="listener-row">
            <span><b>HTTP 端口</b><small>可选独立 HTTP 代理入口</small></span>
            <input v-model.number="form.httpPort" class="core-input port-input" type="number" min="0" max="65535" aria-label="http-port" />
          </label>
          <label class="listener-row">
            <span><b>控制器监听</b><small>固定回环地址，禁止局域网暴露</small></span>
            <span class="controller-address"><i>127.0.0.1:</i><input v-model.number="form.controllerPort" class="core-input port-input" type="number" min="1024" max="65535" aria-label="controller-port" /></span>
          </label>
          <div class="listener-row">
            <span><b>访问密钥</b><small>每次启动随机生成，永不发送到界面</small></span>
            <span class="secret-mask" aria-label="访问密钥已安全隐藏">••••••••••••</span>
          </div>
          <div class="listener-row locked-option">
            <span><b>控制器面板</b><small>未内置 Web 面板，控制器仅供本应用自身使用</small></span>
            <span class="locked-state">未启用</span>
          </div>
          <div class="listener-row locked-option">
            <span><b>允许局域网连接</b><small>安全策略固定关闭，所有代理入口仅监听本机</small></span>
            <span class="locked-state">已关闭</span>
          </div>
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
            <span class="core-label">TCP 并发连接</span>
          </label>
          <label class="core-switch small">
            <input v-model="form.unifiedDelay" type="checkbox" aria-label="unified-delay" />
            <span class="core-switch-track" />
            <span class="core-label">统一延迟</span>
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
.controller-address { display: inline-flex; align-items: center; gap: 4px; }
.controller-address i { color: var(--app-muted); font-size: 11px; font-style: normal; }
.secret-mask { min-width: 112px; padding: 8px 10px; border: 1px solid var(--app-divider); border-radius: 7px; background: var(--app-surface-solid); color: var(--app-muted); font-size: 13px; letter-spacing: 2px; text-align: center; }
.locked-state { min-width: 64px; padding: 5px 9px; border-radius: 999px; background: var(--app-surface-solid); color: var(--app-muted); font-size: 10px; text-align: center; }
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
