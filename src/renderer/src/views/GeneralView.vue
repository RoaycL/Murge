<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useStartupStore } from '../stores/startup'
import { useAppSettingsStore } from '../stores/app-settings'
import AppSelect from '../components/AppSelect.vue'
import type { ConfigBackupPreview } from '@shared/config-backup'

const startup = useStartupStore()
const appSettings = useAppSettingsStore()
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
const webdavUrl = ref('')
const webdavUsername = ref('')
const webdavPassword = ref('')
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

function webdavTarget(): { url: string; username: string; password: string } {
  return { url: webdavUrl.value.trim(), username: webdavUsername.value.trim(), password: webdavPassword.value }
}

async function uploadWebDav(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''
  if (backupPassword.value.length < 8 || backupPassword.value !== backupConfirm.value) {
    backupError.value = '请设置至少 8 位备份密码，并确认两次输入一致。'; return
  }
  backupBusy.value = true
  try {
    await window.desktop.backup.webdavUpload(webdavTarget(), backupPassword.value)
    backupNotice.value = '加密备份已上传到 WebDAV。'
    backupPassword.value = ''; backupConfirm.value = ''; webdavPassword.value = ''
  } catch (error) { backupError.value = error instanceof Error ? error.message : 'WebDAV 上传失败' }
  finally { backupBusy.value = false }
}

async function previewWebDav(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''; backupPreview.value = null; restoreConfirmed.value = false
  if (!restorePassword.value) { backupError.value = '请先输入备份密码。'; return }
  backupBusy.value = true
  try {
    backupPreview.value = await window.desktop.backup.webdavPreview(webdavTarget(), restorePassword.value)
    webdavPassword.value = ''
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
        <div class="startup-behavior">
          <span>
            <strong>开机后仅显示托盘图标</strong>
            <span class="startup-detail">不会自动弹出主窗口；手动启动应用仍会正常显示。</span>
          </span>
          <span class="fixed-state">已启用</span>
        </div>
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
            <strong>创建备份</strong>
            <input v-model="backupPassword" type="password" autocomplete="new-password" placeholder="设置至少 8 位备份密码" aria-label="设置备份密码" />
            <input v-model="backupConfirm" type="password" autocomplete="new-password" placeholder="再次输入密码" aria-label="确认备份密码" />
            <button type="button" :disabled="backupBusy" @click="createBackup">保存加密备份…</button>
          </div>
          <div class="backup-action">
            <strong>从备份恢复</strong>
            <input v-model="restorePassword" type="password" autocomplete="off" placeholder="输入备份密码" aria-label="备份恢复密码" />
            <button type="button" :disabled="backupBusy" @click="previewBackup">选择文件并预览</button>
          </div>
        </div>
        <div class="webdav-backup">
          <strong>WebDAV 备份</strong>
          <p>填写远端 .murge-backup 文件的完整 HTTPS 地址。只上传加密备份；WebDAV 账号和密码不会保存。上传将覆盖同名远端文件。</p>
          <input v-model="webdavUrl" type="url" spellcheck="false" placeholder="https://dav.example.com/backups/backup.murge-backup" aria-label="WebDAV 备份文件地址" />
          <div class="webdav-credentials"><input v-model="webdavUsername" autocomplete="username" placeholder="WebDAV 用户名" aria-label="WebDAV 用户名" /><input v-model="webdavPassword" type="password" autocomplete="off" placeholder="WebDAV 密码" aria-label="WebDAV 密码" /></div>
          <div class="webdav-actions"><button type="button" :disabled="backupBusy || !webdavUrl.trim()" @click="uploadWebDav">上传加密备份</button><button type="button" :disabled="backupBusy || !webdavUrl.trim()" @click="previewWebDav">下载并预览恢复</button></div>
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
.delay-url-field{width:min(430px,60vw)!important;height:32px!important;padding:0 10px;border:1px solid var(--app-divider);border-radius:8px;background:color-mix(in srgb,var(--app-surface) 88%,var(--app-bg));color:var(--app-text);font-size:12px}
.startup-behavior{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px}
.startup-behavior span:first-child{display:flex;flex-direction:column;gap:3px}
.startup-detail{color:var(--app-text-secondary);font-size:11px;font-weight:400}
.fixed-state{color:var(--app-accent);font-size:12px;font-weight:600}
.backup-panel{padding:20px}
.backup-intro strong{font-size:14px}
.backup-intro p{max-width:650px;margin:5px 0 18px;color:var(--app-muted);font-size:11px;line-height:1.6}
.backup-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.backup-action{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:16px;border:1px solid var(--app-divider);border-radius:13px;background:color-mix(in srgb,var(--app-bg) 55%,var(--app-surface))}
.backup-action>strong{font-size:13px}
.backup-action>input{width:100%;max-width:320px;height:35px;padding:0 11px;border:1px solid var(--app-divider);border-radius:8px;background:var(--app-surface);color:var(--app-text)}
.backup-action>button,.backup-preview>button{border:0;border-radius:8px;background:var(--app-accent);color:white;padding:8px 13px;cursor:pointer}
.backup-action button:disabled{opacity:.5;cursor:not-allowed}
.backup-preview{display:flex;flex-direction:column;gap:7px;width:100%;padding:12px;border-radius:10px;background:color-mix(in srgb,var(--app-accent) 9%,var(--app-surface));font-size:11px;line-height:1.5}
.backup-preview.incompatible{background:color-mix(in srgb,#e96952 10%,var(--app-surface))}
.backup-preview span{overflow-wrap:anywhere}
.backup-preview label{display:flex;align-items:center;gap:7px;margin:5px 0}
.webdav-backup{display:grid;gap:9px;margin-top:16px;padding:16px;border:1px solid var(--app-divider);border-radius:13px}
.webdav-backup>strong{font-size:13px}
.webdav-backup p{margin:0;color:var(--app-muted);font-size:11px;line-height:1.5}
.webdav-backup input{min-width:0;width:100%;height:35px;padding:0 11px;border:1px solid var(--app-divider);border-radius:8px;background:var(--app-surface);color:var(--app-text)}
.webdav-credentials{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.webdav-actions{display:flex;gap:10px;flex-wrap:wrap}
.webdav-actions button{padding:8px 13px;border:0;border-radius:8px;background:var(--app-accent);color:white;cursor:pointer}
.webdav-actions button:disabled{opacity:.5;cursor:not-allowed}
.backup-panel>.backup-preview{margin-top:16px}
@media(max-width:760px){.backup-grid{grid-template-columns:1fr}}
</style>
