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
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: startup.status.enabled }"
            :aria-checked="startup.status.enabled"
            :disabled="!startup.status.supported || startup.busy"
            aria-label="登录 Windows 时启动"
            @click="startup.setEnabled(!startup.status.enabled)"
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
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.autoStartKernel }"
            :aria-checked="appSettings.settings.autoStartKernel"
            :disabled="appSettings.busy"
            aria-label="启动时自动启动内核"
            @click="appSettings.set({ autoStartKernel: !appSettings.settings.autoStartKernel })"
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
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.autoCheckUpdate }"
            :aria-checked="appSettings.settings.autoCheckUpdate"
            :disabled="appSettings.busy"
            aria-label="启动时自动检查更新"
            @click="appSettings.set({ autoCheckUpdate: !appSettings.settings.autoCheckUpdate })"
          />
        </label>
      </div>
    </section>

  </div>
</template>
