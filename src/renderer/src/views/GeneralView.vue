<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useStartupStore } from '../stores/startup'
import { useAppSettingsStore } from '../stores/app-settings'
import { useKernelManagerStore } from '../stores/kernel-manager'
import KernelVersionModal from '../components/KernelVersionModal.vue'

const startup = useStartupStore()
const appSettings = useAppSettingsStore()
const kernelManager = useKernelManagerStore()

const showVersionModal = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(() => {
  void startup.refresh()
  void appSettings.refresh()
  void kernelManager.refresh()
  unsubscribe = kernelManager.subscribe()
})

onUnmounted(() => {
  unsubscribe?.()
})

function toggleKernelEnabled(): void {
  void kernelManager.setEnabled(!kernelManager.state.enabled)
}

function onChannelChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'specific') {
    showVersionModal.value = true
  } else {
    void kernelManager.setChannel('stable')
  }
}

function closeVersionModal(): void {
  showVersionModal.value = false
}

const channelDescription = (): string => {
  const state = kernelManager.state
  if (state.channel === 'specific' && state.specificVersion) {
    return `当前使用指定版本 ${state.effectiveVersion}`
  }
  return `当前使用内置稳定版 ${state.stableVersion}`
}
</script>

<template>
  <div class="page-shell general-view">
    <h1>通用</h1>

    <section>
      <h2>启动</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>登录 Windows 时启动</strong>
            <small>应用在后台启动并显示托盘图标，不会自动启动内核或代理。</small>
          </span>
          <input
            :checked="startup.status.enabled"
            type="checkbox"
            :disabled="!startup.status.supported || startup.busy"
            @change="startup.setEnabled(($event.target as HTMLInputElement).checked)"
          />
        </label>
      </div>
      <p v-if="startup.status.phase === 'unsupported'" class="setting-help">此平台不支持该设置；Windows 安装包中可用。</p>
      <p v-else-if="startup.status.errorMessage" class="inline-error">{{ startup.status.errorMessage }}</p>
    </section>

    <section>
      <h2>内核</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>启动时自动启动内核</strong>
            <small>打开应用后直接运行本机回环内核，策略和规则立即可用，无需手动连接。不影响系统代理与 TUN（仍由你主动启用）。</small>
          </span>
          <input
            :checked="appSettings.settings.autoStartKernel"
            type="checkbox"
            :disabled="appSettings.busy"
            @change="appSettings.set({ autoStartKernel: ($event.target as HTMLInputElement).checked })"
          />
        </label>
      </div>
      <p v-if="appSettings.errorMessage" class="inline-error">{{ appSettings.errorMessage }}</p>
    </section>

    <section>
      <h2>内核管理</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>启用 Smart 内核</strong>
            <small>关闭后内核不会启动；仍可手动启用其开关，但内核、系统代理与 TUN 均无法接管。</small>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: kernelManager.state.enabled }"
            :aria-checked="kernelManager.state.enabled"
            :disabled="kernelManager.busy"
            aria-label="启用 Smart 内核"
            @click="toggleKernelEnabled"
          />
        </label>
        <label>
          <span>
            <strong>内核版本</strong>
            <small>{{ channelDescription() }}</small>
          </span>
          <select
            :value="kernelManager.state.channel"
            :disabled="kernelManager.busy || !kernelManager.state.enabled"
            aria-label="内核版本"
            @change="onChannelChange"
          >
            <option value="stable">稳定版</option>
            <option value="specific">选择特定版本…</option>
          </select>
        </label>
      </div>
      <p v-if="kernelManager.state.installing" class="setting-help">正在下载并校验 {{ kernelManager.state.installing }}…</p>
      <p v-if="kernelManager.errorMessage" class="inline-error">{{ kernelManager.errorMessage }}</p>
    </section>

    <section>
      <h2>更新</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>启动时自动检查更新</strong>
            <small>发布新版本后自动检查并后台下载，退出应用时自动安装；可在“关于”中手动检查。关闭后仍可手动检查更新。</small>
          </span>
          <input
            :checked="appSettings.settings.autoCheckUpdate"
            type="checkbox"
            :disabled="appSettings.busy"
            @change="appSettings.set({ autoCheckUpdate: ($event.target as HTMLInputElement).checked })"
          />
        </label>
      </div>
    </section>

    <section>
      <h2>安全行为</h2>
      <div class="surface-card general-info">
        <p>开机启动只启动桌面程序和托盘；登录时内核、系统代理和 TUN 均不会自动启用。正常打开应用时，内核会在启动后自动运行（可在上方关闭）；开启系统代理时，内核会随之自动启动。</p>
      </div>
    </section>

    <KernelVersionModal v-if="showVersionModal" @close="closeVersionModal" />
  </div>
</template>
