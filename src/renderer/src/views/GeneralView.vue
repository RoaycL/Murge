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
            <small>注册系统登录项，开机后自动拉起应用并恢复内核与代理接管。</small>
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
        <label>
          <span>
            <strong>静默启动</strong>
            <small>登录自启时不在桌面弹出主窗口，仅保留托盘图标；手动打开应用不受影响。</small>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.silentLaunch }"
            :aria-checked="appSettings.settings.silentLaunch"
            :disabled="appSettings.busy"
            aria-label="静默启动"
            @click="appSettings.set({ silentLaunch: !appSettings.settings.silentLaunch })"
          />
        </label>
        <label>
          <span>
            <strong>关闭窗口时最小化到托盘</strong>
            <small>关闭后仅隐藏窗口并在托盘继续接管代理；关闭后应用完全退出并还原系统代理。</small>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.closeToTray }"
            :aria-checked="appSettings.settings.closeToTray"
            :disabled="appSettings.busy"
            aria-label="关闭窗口时最小化到托盘"
            @click="appSettings.set({ closeToTray: !appSettings.settings.closeToTray })"
          />
        </label>
      </div>
      <p v-if="startup.status.phase === 'unsupported'" class="setting-help">登录项在此平台不可用；Windows 安装包中可用。</p>
      <p v-else-if="startup.status.errorMessage" class="inline-error">{{ startup.status.errorMessage }}</p>
      <p v-if="appSettings.errorMessage" class="inline-error">{{ appSettings.errorMessage }}</p>
    </section>

    <section>
      <h2>内核</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>启动时自动启动内核</strong>
            <small>应用打开后立即拉起 mihomo，策略与规则页无需手动启动即可显示实时数据。</small>
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
    </section>

    <section>
      <h2>网络守护</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>系统代理守护</strong>
            <small>系统代理开启期间，定时校验并修复被其他程序篡改的代理设置，避免「代理已开启但无法上网」。</small>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.proxyGuard }"
            :aria-checked="appSettings.settings.proxyGuard"
            :disabled="appSettings.busy"
            aria-label="系统代理守护"
            @click="appSettings.set({ proxyGuard: !appSettings.settings.proxyGuard })"
          />
        </label>
      </div>
    </section>

    <section>
      <h2>更新</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>启动时自动检查更新</strong>
            <small>有新版本时后台下载，退出应用时提示安装；手动「检查更新」始终可用。</small>
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
          <span>
            <strong>测试地址来源</strong>
            <small>策略组自带的测试地址优先，或始终使用下方统一地址。</small>
          </span>
          <AppSelect v-model="delayScope" :options="delayScopeOptions" label="测试地址来源" />
        </label>
        <label>
          <span>
            <strong>全局测试地址</strong>
            <small>仅「始终使用全局地址」时生效；留空使用内置的 204 无内容地址。</small>
          </span>
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
