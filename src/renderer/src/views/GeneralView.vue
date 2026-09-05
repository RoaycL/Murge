<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useStartupStore } from '../stores/startup'
import { useAppSettingsStore } from '../stores/app-settings'
import AppSelect from '../components/AppSelect.vue'

const startup = useStartupStore()
const appSettings = useAppSettingsStore()
const delayUrl = ref('')
const delayUrlError = ref<string | null>(null)
const delayScopeOptions = [
  { value: 'group', label: '跟随策略组' },
  { value: 'global', label: '始终使用全局地址' }
]
const delayScope = computed({
  get: () => appSettings.settings.delayTestUrlScope,
  set: (value: string) => {
    if (value === 'group' || value === 'global') void appSettings.set({ delayTestUrlScope: value })
  }
})

async function saveDelayUrl(): Promise<void> {
  const value = delayUrl.value.trim()
  if (value) {
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme')
    } catch {
      delayUrlError.value = '请输入有效的 HTTP 或 HTTPS 测试地址。'
      return
    }
  }
  delayUrlError.value = null
  if (value === appSettings.settings.delayTestUrl) return
  if (!(await appSettings.set({ delayTestUrl: value }))) {
    delayUrl.value = appSettings.settings.delayTestUrl
    delayUrlError.value = appSettings.errorMessage
  }
}

onMounted(async () => {
  void startup.refresh()
  await appSettings.refresh()
  delayUrl.value = appSettings.settings.delayTestUrl
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

    <section>
      <h2>延迟测试</h2>
      <div class="surface-card preference-list delay-preferences">
        <label>
          <span><strong>测试地址来源</strong></span>
          <AppSelect v-model="delayScope" :options="delayScopeOptions" label="测试地址来源" />
        </label>
        <label>
          <span><strong>全局测试地址</strong></span>
          <input
            v-model="delayUrl"
            class="delay-url-field"
            type="url"
            spellcheck="false"
            placeholder="https://www.gstatic.com/generate_204"
            @change="saveDelayUrl"
            @blur="saveDelayUrl"
            @keydown.enter.prevent="saveDelayUrl"
          />
        </label>
      </div>
      <p v-if="delayUrlError" class="inline-error">{{ delayUrlError }}</p>
    </section>

  </div>
</template>

<style scoped>
.delay-url-field{width:min(430px,60vw)!important;height:32px!important;padding:0 10px;border:1px solid var(--app-divider);border-radius:8px;background:color-mix(in srgb,var(--app-surface) 88%,var(--app-bg));color:var(--app-text);font-size:12px}
</style>
