<script setup lang="ts">
import { onMounted } from 'vue'
import { useStartupStore } from '../stores/startup'
import { useAppSettingsStore } from '../stores/app-settings'

const startup = useStartupStore()
const appSettings = useAppSettingsStore()

onMounted(() => {
  void startup.refresh()
  void appSettings.refresh()
})
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

  </div>
</template>
