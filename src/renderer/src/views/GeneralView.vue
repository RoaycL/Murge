<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useStartupStore } from '../stores/startup'
import { useAppSettingsStore } from '../stores/app-settings'
import { useProfilesStore } from '../stores/profiles'
import { useRuntimeStore } from '../stores/runtime'
import AppSelect from '../components/AppSelect.vue'
import AppIcon from '../components/AppIcon.vue'
import type { ConfigBackupPreview } from '@shared/config-backup'
import { composeWebDavFileUrl, defaultWebDavFilePath, type WebDavBackupTarget } from '@shared/webdav-backup'

const startup = useStartupStore()
const appSettings = useAppSettingsStore()
const profilesStore = useProfilesStore()
const runtime = useRuntimeStore()
const newDirectSsid = ref('')
const newRuleSsid = ref('')
const newRuleProfile = ref('')
const GENERIC_NETWORK_NAMES = new Set(['以太网', 'Wi-Fi', '蜂窝网络', '无网络'])
/** The current Wi-Fi name when the summary shows one (generic labels mean unknown). */
const currentSsid = computed(() => {
  const name = runtime.summary?.networkName?.trim() ?? ''
  return name && !GENERIC_NETWORK_NAMES.has(name) ? name : ''
})
const profileOptions = computed(() => profilesStore.ordered.map((meta) => ({ value: meta.id, label: meta.name })))
function profileName(id: string): string {
  return profilesStore.profiles.find((meta) => meta.id === id)?.name ?? '已删除的配置'
}
function addDirectSsid(value: string): void {
  const ssid = value.trim()
  if (!ssid || appSettings.settings.wifiDirectSsids.includes(ssid)) return
  void appSettings.set({ wifiDirectSsids: [...appSettings.settings.wifiDirectSsids, ssid] })
  newDirectSsid.value = ''
}
function removeDirectSsid(ssid: string): void {
  void appSettings.set({ wifiDirectSsids: appSettings.settings.wifiDirectSsids.filter((item) => item !== ssid) })
}
function addProfileRule(): void {
  const ssid = newRuleSsid.value.trim()
  const profileId = newRuleProfile.value || profileOptions.value[0]?.value || ''
  if (!ssid || !profileId) return
  const rules = appSettings.settings.wifiProfileRules.filter((rule) => rule.ssid !== ssid)
  void appSettings.set({ wifiProfileRules: [...rules, { ssid, profileId }] })
  newRuleSsid.value = ''
}
function setRuleProfile(ssid: string, profileId: string): void {
  void appSettings.set({ wifiProfileRules: appSettings.settings.wifiProfileRules.map((rule) => (rule.ssid === ssid ? { ssid, profileId } : rule)) })
}
function removeProfileRule(ssid: string): void {
  void appSettings.set({ wifiProfileRules: appSettings.settings.wifiProfileRules.filter((rule) => rule.ssid !== ssid) })
}
const delayUrl = ref('')
const delayUrlError = ref<string | null>(null)
const backupPassword = ref('')
const backupConfirm = ref('')
const restorePassword = ref('')
const backupBusy = ref(false)
const backupError = ref('')
const backupNotice = ref('')
const backupPreview = ref<ConfigBackupPreview | null>(null)
const restoreConfirmed = ref(false)
const webdavAddress = ref('')
const webdavDefaultPath = ref(defaultWebDavFilePath(''))
const webdavFilePath = ref(webdavDefaultPath.value)
const webdavUsername = ref('')
const webdavPassword = ref('')
const webdavPassphrase = ref('')
const webdavPasswordVisible = ref(false)
const webdavPassphraseVisible = ref(false)
const webdavFileUrl = computed(() => composeWebDavFileUrl(webdavAddress.value, webdavFilePath.value, webdavDefaultPath.value))
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

async function createBackup(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''
  if (backupPassword.value.length < 8 || backupPassword.value !== backupConfirm.value) {
    backupError.value = '请设置至少 8 位密码，并确认两次输入一致。'
    return
  }
  backupBusy.value = true
  try {
    const result = await window.desktop.backup.create(backupPassword.value)
    if (result.saved) { backupNotice.value = '加密备份已保存到你选择的位置。'; backupPassword.value = ''; backupConfirm.value = '' }
  } catch (error) { backupError.value = error instanceof Error ? error.message : '备份失败' }
  finally { backupBusy.value = false }
}

async function previewBackup(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''; backupPreview.value = null; restoreConfirmed.value = false
  if (!restorePassword.value) { backupError.value = '请先输入备份密码。'; return }
  backupBusy.value = true
  try { backupPreview.value = await window.desktop.backup.preview(restorePassword.value) }
  catch (error) { backupError.value = error instanceof Error ? error.message : '读取备份失败' }
  finally { backupBusy.value = false }
}

function webdavTarget(): WebDavBackupTarget {
  return { url: webdavFileUrl.value, username: webdavUsername.value.trim(), password: webdavPassword.value }
}

async function uploadWebDav(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''
  if (webdavPassphrase.value.length < 8) {
    backupError.value = '请为 WebDAV 备份设置至少 8 位加密口令，恢复时需要输入同一口令。'; return
  }
  backupBusy.value = true
  try {
    await window.desktop.backup.webdavUpload(webdavTarget(), webdavPassphrase.value)
    backupNotice.value = '加密备份已上传到 WebDAV。'
    webdavPassword.value = ''; webdavPassphrase.value = ''
  } catch (error) { backupError.value = error instanceof Error ? error.message : 'WebDAV 上传失败' }
  finally { backupBusy.value = false }
}

async function previewWebDav(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''; backupPreview.value = null; restoreConfirmed.value = false
  if (!webdavPassphrase.value) { backupError.value = '请输入上传这份 WebDAV 备份时设置的加密口令。'; return }
  backupBusy.value = true
  try {
    backupPreview.value = await window.desktop.backup.webdavPreview(webdavTarget(), webdavPassphrase.value)
    webdavPassword.value = ''; webdavPassphrase.value = ''
  } catch (error) { backupError.value = error instanceof Error ? error.message : 'WebDAV 下载失败' }
  finally { backupBusy.value = false }
}

async function restoreBackup(): Promise<void> {
  if (!backupPreview.value?.compatible || !restoreConfirmed.value || backupBusy.value) return
  backupBusy.value = true; backupError.value = ''
  try {
    await window.desktop.backup.restore(backupPreview.value.token)
    backupNotice.value = '备份已校验并安排恢复，应用即将重启。'
    restorePassword.value = ''
  } catch (error) { backupError.value = error instanceof Error ? error.message : '恢复失败' }
  finally { backupBusy.value = false }
}

onMounted(async () => {
  void startup.refresh()
  if (!profilesStore.profiles.length) void profilesStore.load()
  if (!runtime.summary) void runtime.refresh()
  void window.desktop.app.getBrand().then((brand) => {
    const previous = webdavDefaultPath.value
    webdavDefaultPath.value = defaultWebDavFilePath(brand.productName)
    if (webdavFilePath.value === previous) webdavFilePath.value = webdavDefaultPath.value
  }).catch(() => undefined)
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
        <label class="startup-behavior">
          <span>
            <strong>静默启动</strong>
            <span class="startup-detail">开启后登录 Windows 时只在托盘运行，不弹出主窗口；关闭则自动打开主窗口。手动启动应用总会显示。</span>
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
      <h2>更新</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>自动检查更新</strong>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.autoCheckUpdate }"
            :aria-checked="appSettings.settings.autoCheckUpdate"
            :disabled="appSettings.busy"
            aria-label="自动检查更新"
            @click="appSettings.set({ autoCheckUpdate: !appSettings.settings.autoCheckUpdate })"
          />
        </label>
      </div>
    </section>

    <section>
      <h2>配置备份与恢复</h2>
      <div class="surface-card backup-panel">
        <div class="backup-intro"><strong>加密备份</strong><p>包含配置、订阅及 Sub-Store 用户数据，不包含日志和缓存。备份密码只用于本次操作；忘记密码将无法恢复。</p></div>
        <div class="backup-grid">
          <div class="backup-action">
            <strong>保存到本地文件</strong>
            <input v-model="backupPassword" type="password" autocomplete="new-password" placeholder="设置至少 8 位备份密码" aria-label="设置备份密码" />
            <input v-model="backupConfirm" type="password" autocomplete="new-password" placeholder="再次输入密码" aria-label="确认备份密码" />
            <button type="button" :disabled="backupBusy" @click="createBackup">保存加密备份…</button>
          </div>
          <div class="backup-action">
            <strong>从本地文件恢复</strong>
            <input v-model="restorePassword" type="password" autocomplete="off" placeholder="输入备份密码" aria-label="备份恢复密码" />
            <button type="button" :disabled="backupBusy" @click="previewBackup">选择文件并预览</button>
          </div>
        </div>
        <div class="webdav-backup">
          <strong>WebDAV 备份</strong>
          <p>把加密备份上传到 WebDAV 网盘，或从网盘下载并恢复。加密口令与上方本地备份的密码互不相关；WebDAV 账号、密码和口令都不会保存。</p>
          <div class="webdav-form">
            <label class="webdav-field wide"><span>WebDAV 地址</span><input v-model="webdavAddress" type="url" spellcheck="false" autocomplete="off" placeholder="https://dav.example.com/dav" /></label>
            <label class="webdav-field"><span>用户名</span><input v-model="webdavUsername" spellcheck="false" autocomplete="username" placeholder="WebDAV 用户名" /></label>
            <label class="webdav-field"><span>密码</span><span class="webdav-secret"><input v-model="webdavPassword" :type="webdavPasswordVisible ? 'text' : 'password'" autocomplete="off" placeholder="WebDAV 密码或应用密码" /><button type="button" class="webdav-eye" :class="{ active: webdavPasswordVisible }" :aria-label="webdavPasswordVisible ? '隐藏 WebDAV 密码' : '显示 WebDAV 密码'" @click.prevent="webdavPasswordVisible = !webdavPasswordVisible"><AppIcon name="eye" :size="16" /></button></span></label>
            <label class="webdav-field"><span>文件路径</span><input v-model="webdavFilePath" spellcheck="false" autocomplete="off" :placeholder="webdavDefaultPath" /></label>
            <label class="webdav-field"><span>加密口令（至少 8 位，恢复时需要）</span><span class="webdav-secret"><input v-model="webdavPassphrase" :type="webdavPassphraseVisible ? 'text' : 'password'" autocomplete="new-password" placeholder="设置或输入加密口令" /><button type="button" class="webdav-eye" :class="{ active: webdavPassphraseVisible }" :aria-label="webdavPassphraseVisible ? '隐藏加密口令' : '显示加密口令'" @click.prevent="webdavPassphraseVisible = !webdavPassphraseVisible"><AppIcon name="eye" :size="16" /></button></span></label>
          </div>
          <p v-if="webdavFileUrl" class="webdav-target">远端文件：<code>{{ webdavFileUrl }}</code>。上传将覆盖同名文件。</p>
          <div class="webdav-actions"><button type="button" :disabled="backupBusy || !webdavFileUrl" @click="uploadWebDav">上传加密备份</button><button type="button" :disabled="backupBusy || !webdavFileUrl" @click="previewWebDav">下载并预览恢复</button></div>
        </div>
        <div v-if="backupPreview" class="backup-preview" :class="{ incompatible: !backupPreview.compatible }">
          <strong>恢复前预览</strong>
          <span>备份版本 {{ backupPreview.appVersion }} · {{ new Date(backupPreview.createdAt).toLocaleString() }}</span>
          <span>{{ backupPreview.profileCount }} 个配置 · {{ backupPreview.subscriptionSourceCount }} 个订阅地址 · {{ backupPreview.fileCount }} 个文件</span>
          <span>将替换 {{ backupPreview.replaceCount }} 个现有文件、新增 {{ backupPreview.addCount }} 个、移除 {{ backupPreview.removeCount }} 个</span>
          <span>覆写：{{ backupPreview.includesOverrides ? '包含' : '无' }} · Sub-Store：{{ backupPreview.includesSubStore ? '包含' : '无' }}</span>
          <span>{{ backupPreview.compatibilityMessage }}</span>
          <label v-if="backupPreview.compatible"><input v-model="restoreConfirmed" type="checkbox" /> 我了解恢复将替换当前配置，应用需要重启</label>
          <button v-if="backupPreview.compatible" type="button" :disabled="backupBusy || !restoreConfirmed" @click="restoreBackup">确认恢复并重启</button>
        </div>
      </div>
      <p v-if="backupError" class="inline-error" role="alert">{{ backupError }}</p>
      <p v-if="backupNotice" class="setting-help" role="status">{{ backupNotice }}</p>
    </section>

    <section>
      <h2>连接</h2>
      <div class="surface-card preference-list">
        <label class="startup-behavior">
          <span>
            <strong>切换节点时断开旧连接</strong>
            <span class="startup-detail">切换策略组的节点后，关闭仍经过这个策略组的连接；切换出站模式后关闭全部连接。应用会自动用新节点重新连接，避免长连接卡在旧节点上没有响应。</span>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.autoCloseConnections }"
            :aria-checked="appSettings.settings.autoCloseConnections"
            :disabled="appSettings.busy"
            aria-label="切换节点时断开旧连接"
            @click="appSettings.set({ autoCloseConnections: !appSettings.settings.autoCloseConnections })"
          />
        </label>
      </div>
    </section>

    <section>
      <h2>Wi-Fi 规则</h2>
      <div class="surface-card wifi-rules">
        <div class="wifi-rule-block">
          <span class="wifi-rule-title">
            <strong>在这些 Wi-Fi 下使用直连</strong>
            <span class="startup-detail">连上列表里的 Wi-Fi 后自动切换到直连模式，离开后恢复原来的模式。适合公司或家里不需要代理的网络。</span>
          </span>
          <div v-if="appSettings.settings.wifiDirectSsids.length" class="wifi-chips">
            <span v-for="ssid in appSettings.settings.wifiDirectSsids" :key="ssid" class="wifi-chip">{{ ssid }}<button type="button" :aria-label="`移除 ${ssid}`" :disabled="appSettings.busy" @click="removeDirectSsid(ssid)"><AppIcon name="close" :size="12" /></button></span>
          </div>
          <div class="wifi-add">
            <input v-model="newDirectSsid" spellcheck="false" maxlength="32" placeholder="Wi-Fi 名称" aria-label="直连 Wi-Fi 名称" @keydown.enter.prevent="addDirectSsid(newDirectSsid)" />
            <button type="button" class="secondary-button" :disabled="appSettings.busy || !newDirectSsid.trim()" @click="addDirectSsid(newDirectSsid)">添加</button>
            <button v-if="currentSsid && !appSettings.settings.wifiDirectSsids.includes(currentSsid)" type="button" class="secondary-button" :disabled="appSettings.busy" @click="addDirectSsid(currentSsid)">添加当前 Wi-Fi「{{ currentSsid }}」</button>
          </div>
        </div>
        <div class="wifi-rule-block">
          <span class="wifi-rule-title">
            <strong>按 Wi-Fi 切换配置</strong>
            <span class="startup-detail">连上指定的 Wi-Fi 后自动切换到对应的配置，离开后切回原来的配置。期间手动换过配置时不会再切回。</span>
          </span>
          <div v-for="rule in appSettings.settings.wifiProfileRules" :key="rule.ssid" class="wifi-rule-row">
            <strong>{{ rule.ssid }}</strong>
            <AppSelect v-if="profileOptions.some((option) => option.value === rule.profileId)" :model-value="rule.profileId" :options="profileOptions" :label="`${rule.ssid} 使用的配置`" @update:model-value="(value: string) => setRuleProfile(rule.ssid, value)" />
            <span v-else class="startup-detail">{{ profileName(rule.profileId) }}</span>
            <button type="button" class="wifi-remove" :aria-label="`删除 ${rule.ssid} 的规则`" :disabled="appSettings.busy" @click="removeProfileRule(rule.ssid)"><AppIcon name="close" :size="15" /></button>
          </div>
          <div v-if="profileOptions.length" class="wifi-add">
            <input v-model="newRuleSsid" spellcheck="false" maxlength="32" :placeholder="currentSsid || 'Wi-Fi 名称'" aria-label="切换配置的 Wi-Fi 名称" @keydown.enter.prevent="addProfileRule" />
            <AppSelect :model-value="newRuleProfile || profileOptions[0]?.value || ''" :options="profileOptions" label="切换到的配置" @update:model-value="(value: string) => (newRuleProfile = value)" />
            <button type="button" class="secondary-button" :disabled="appSettings.busy || !newRuleSsid.trim()" @click="addProfileRule">添加</button>
          </div>
        </div>
        <p class="startup-detail">Windows 11 需要在「设置 → 隐私和安全性 → 位置」里允许桌面应用访问位置，应用才能读到 Wi-Fi 名称；读不到时这些规则不会生效。</p>
      </div>
    </section>

    <section>
      <h2>延迟测试</h2>
      <div class="surface-card preference-list delay-preferences">
        <label>
          <span>
            <strong>测试地址来源</strong>
          </span>
          <AppSelect v-model="delayScope" :options="delayScopeOptions" label="测试地址来源" />
        </label>
        <label>
          <span>
            <strong>全局测试地址</strong>
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
.delay-url-field{width:min(430px,60vw)!important;height:32px!important;padding:0 10px;border:1px solid var(--app-divider);border-radius:var(--radius-control);background:color-mix(in srgb,var(--app-surface) 88%,var(--app-bg));color:var(--app-text);font-size:var(--font-size-sm)}
.startup-behavior{gap:var(--space-7)}
.startup-behavior span:first-child{display:flex;flex-direction:column;gap:var(--space-1)}
.startup-detail{color:var(--app-muted);font-size:var(--font-size-xs);font-weight:var(--font-weight-regular)}
.wifi-rules{display:grid;gap:var(--space-6);padding:16px 20px}
.wifi-rule-block{display:grid;gap:var(--space-4)}
.wifi-rule-title{display:flex;flex-direction:column;gap:var(--space-1)}
.wifi-chips{display:flex;flex-wrap:wrap;gap:var(--space-3)}
.wifi-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;border-radius:999px;background:color-mix(in srgb,var(--app-accent) 12%,var(--app-surface));font-size:var(--font-size-sm)}
.wifi-chip button{display:inline-flex;border:0;background:transparent;color:var(--app-muted);cursor:pointer;padding:2px}
.wifi-add,.wifi-rule-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-4)}
.wifi-rule-row>strong{min-width:120px;font-size:var(--font-size-sm)}
.wifi-add input{width:min(220px,50vw);height:32px;padding:0 10px;border:1px solid var(--app-divider);border-radius:var(--radius-control);background:color-mix(in srgb,var(--app-surface) 88%,var(--app-bg));color:var(--app-text);font-size:var(--font-size-sm)}
.wifi-rules>p{margin:0}
.wifi-remove{display:grid;width:28px;height:28px;place-items:center;padding:0;border:0;border-radius:var(--radius-control);background:transparent;color:var(--app-warning);cursor:pointer}
.wifi-remove:hover{background:var(--app-fill)}
.backup-panel{padding:20px}
.backup-intro strong{font-size:var(--font-size-body)}
.backup-intro p{max-width:650px;margin:5px 0 18px;color:var(--app-muted);font-size:var(--font-size-xs);line-height:1.6}
.backup-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-7)}
.backup-action{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-4);padding:16px;border:1px solid var(--app-divider);border-radius:var(--radius-card);background:color-mix(in srgb,var(--app-bg) 55%,var(--app-surface))}
.backup-action>strong{font-size:var(--font-size-md)}
.backup-action>input{width:100%;max-width:320px;height:35px;padding:0 11px;border:1px solid var(--app-divider);border-radius:var(--radius-control);background:var(--app-surface);color:var(--app-text)}
.backup-action>button{margin-top:auto}
.backup-action>button,.backup-preview>button{border:0;border-radius:var(--radius-control);background:var(--app-accent);color:var(--app-on-accent);padding:8px 13px;cursor:pointer}
.backup-action button:disabled{opacity:.5;cursor:not-allowed}
.backup-preview{display:flex;flex-direction:column;gap:var(--space-3);width:100%;padding:12px;border-radius:var(--radius-md);background:color-mix(in srgb,var(--app-accent) 9%,var(--app-surface));font-size:var(--font-size-xs);line-height:1.5}
.backup-preview.incompatible{background:color-mix(in srgb,var(--app-danger) 10%,var(--app-surface))}
.backup-preview span{overflow-wrap:anywhere}
.backup-preview label{display:flex;align-items:center;gap:var(--space-3);margin:5px 0}
.webdav-backup{display:grid;gap:var(--space-4);margin-top:16px;padding:16px;border:1px solid var(--app-divider);border-radius:var(--radius-card)}
.webdav-backup>strong{font-size:var(--font-size-md)}
.webdav-backup p{margin:0;color:var(--app-muted);font-size:var(--font-size-xs);line-height:1.5}
.webdav-backup input{min-width:0;width:100%;height:35px;padding:0 11px;border:1px solid var(--app-divider);border-radius:var(--radius-control);background:var(--app-surface);color:var(--app-text)}
.webdav-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-5) var(--space-6)}
.webdav-field{display:grid;gap:6px;min-width:0}
.webdav-field.wide{grid-column:1/-1}
.webdav-field>span:first-child{color:var(--app-muted);font-size:var(--font-size-xs)}
.webdav-secret{position:relative;display:block;min-width:0}
.webdav-secret input{padding-right:40px}
.webdav-eye{position:absolute;top:50%;right:4px;width:28px;height:28px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--app-muted);cursor:pointer}
.webdav-eye:hover,.webdav-eye.active{color:var(--app-text);background:color-mix(in srgb,var(--app-text) 8%,transparent)}
.webdav-backup .webdav-target{overflow-wrap:anywhere}
.webdav-target code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--app-text)}
.webdav-actions{display:flex;gap:var(--space-4);flex-wrap:wrap}
.webdav-actions button{padding:8px 13px;border:0;border-radius:var(--radius-control);background:var(--app-accent);color:var(--app-on-accent);cursor:pointer}
.webdav-actions button:disabled{opacity:.5;cursor:not-allowed}
.backup-panel>.backup-preview{margin-top:16px}
@media(max-width:760px){.backup-grid,.webdav-form{grid-template-columns:1fr}}
</style>
