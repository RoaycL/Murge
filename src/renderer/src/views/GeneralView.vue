<script setup lang="ts">
import { LOCALE_NAMES, LOCALES, locale, t, type LanguageSetting } from '@shared/i18n'
import { computed, onMounted, ref } from 'vue'
import { useStartupStore } from '../stores/startup'
import { useAppSettingsStore } from '../stores/app-settings'
import AppSelect from '../components/AppSelect.vue'
import AppIcon from '../components/AppIcon.vue'
import type { ConfigBackupPreview } from '@shared/config-backup'
import { composeWebDavFileUrl, defaultWebDavFilePath, type WebDavBackupTarget } from '@shared/webdav-backup'

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
const webdavAddress = ref('')
const webdavDefaultPath = ref(defaultWebDavFilePath(''))
const webdavFilePath = ref(webdavDefaultPath.value)
const webdavUsername = ref('')
const webdavPassword = ref('')
const webdavPassphrase = ref('')
const webdavPasswordVisible = ref(false)
const webdavPassphraseVisible = ref(false)
const webdavFileUrl = computed(() => composeWebDavFileUrl(webdavAddress.value, webdavFilePath.value, webdavDefaultPath.value))
const languageOptions = [
  { value: 'system', label: t('common.followSystem') },
  ...LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))
]
const language = computed({
  get: () => appSettings.settings.language,
  set: (value: string) => { void appSettings.set({ language: value as LanguageSetting }) }
})
const delayScopeOptions = [
  { value: 'group', label: t('general.scopeGroup') },
  { value: 'global', label: t('general.scopeGlobal') }
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
      delayUrlError.value = t('general.urlInvalid')
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
    backupError.value = t('general.passwordRule')
    return
  }
  backupBusy.value = true
  try {
    const result = await window.desktop.backup.create(backupPassword.value)
    if (result.saved) { backupNotice.value = t('general.backupSaved'); backupPassword.value = ''; backupConfirm.value = '' }
  } catch (error) { backupError.value = error instanceof Error ? error.message : t('general.backupFailed') }
  finally { backupBusy.value = false }
}

async function previewBackup(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''; backupPreview.value = null; restoreConfirmed.value = false
  if (!restorePassword.value) { backupError.value = t('general.passwordFirst'); return }
  backupBusy.value = true
  try { backupPreview.value = await window.desktop.backup.preview(restorePassword.value) }
  catch (error) { backupError.value = error instanceof Error ? error.message : t('general.readFailed') }
  finally { backupBusy.value = false }
}

function webdavTarget(): WebDavBackupTarget {
  return { url: webdavFileUrl.value, username: webdavUsername.value.trim(), password: webdavPassword.value }
}

async function uploadWebDav(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''
  if (webdavPassphrase.value.length < 8) {
    backupError.value = t('general.webdavPassphraseRule'); return
  }
  backupBusy.value = true
  try {
    await window.desktop.backup.webdavUpload(webdavTarget(), webdavPassphrase.value)
    backupNotice.value = t('general.webdavUploaded')
    webdavPassword.value = ''; webdavPassphrase.value = ''
  } catch (error) { backupError.value = error instanceof Error ? error.message : t('general.webdavUploadFailed') }
  finally { backupBusy.value = false }
}

async function previewWebDav(): Promise<void> {
  if (backupBusy.value) return
  backupError.value = ''; backupNotice.value = ''; backupPreview.value = null; restoreConfirmed.value = false
  if (!webdavPassphrase.value) { backupError.value = t('general.webdavPassphraseNeeded'); return }
  backupBusy.value = true
  try {
    backupPreview.value = await window.desktop.backup.webdavPreview(webdavTarget(), webdavPassphrase.value)
    webdavPassword.value = ''; webdavPassphrase.value = ''
  } catch (error) { backupError.value = error instanceof Error ? error.message : t('general.webdavDownloadFailed') }
  finally { backupBusy.value = false }
}

async function restoreBackup(): Promise<void> {
  if (!backupPreview.value?.compatible || !restoreConfirmed.value || backupBusy.value) return
  backupBusy.value = true; backupError.value = ''
  try {
    await window.desktop.backup.restore(backupPreview.value.token)
    backupNotice.value = t('general.restoreScheduled')
    restorePassword.value = ''
  } catch (error) { backupError.value = error instanceof Error ? error.message : t('general.restoreFailed') }
  finally { backupBusy.value = false }
}

onMounted(async () => {
  void startup.refresh()
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
  <div class="page-shell general-view page-readable">
    <h1>{{ t('general.title') }}</h1>

    <section>
      <h2>{{ t('general.language') }}</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>{{ t('general.interfaceLanguage') }}</strong>
          </span>
          <AppSelect v-model="language" :options="languageOptions" :label="t('general.interfaceLanguage')" />
        </label>
      </div>
    </section>

    <section>
      <h2>{{ t('general.startup') }}</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>{{ t('general.launchAtLogin') }}</strong>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: startup.status.enabled }"
            :aria-checked="startup.status.enabled"
            :disabled="!startup.status.supported || startup.busy"
            :aria-label="t('general.launchAtLogin')"
            @click="startup.setEnabled(!startup.status.enabled)"
          />
        </label>
        <label class="startup-behavior">
          <span>
            <strong>{{ t('general.silentLaunch') }}</strong>
            <span class="startup-detail">{{ t('general.silentLaunchHint') }}</span>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.silentLaunch }"
            :aria-checked="appSettings.settings.silentLaunch"
            :disabled="appSettings.busy"
            :aria-label="t('general.silentLaunch')"
            @click="appSettings.set({ silentLaunch: !appSettings.settings.silentLaunch })"
          />
        </label>
        <label>
          <span>
            <strong>{{ t('general.closeToTray') }}</strong>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.closeToTray }"
            :aria-checked="appSettings.settings.closeToTray"
            :disabled="appSettings.busy"
            :aria-label="t('general.closeToTray')"
            @click="appSettings.set({ closeToTray: !appSettings.settings.closeToTray })"
          />
        </label>
      </div>
      <p v-if="startup.status.phase === 'unsupported'" class="setting-help">{{ t('general.loginUnavailable') }}</p>
      <p v-else-if="startup.status.errorMessage" class="inline-error">{{ startup.status.errorMessage }}</p>
      <p v-if="appSettings.errorMessage" class="inline-error">{{ appSettings.errorMessage }}</p>
    </section>

    <section>
      <h2>{{ t('general.update') }}</h2>
      <div class="surface-card preference-list">
        <label>
          <span>
            <strong>{{ t('general.autoCheck') }}</strong>
          </span>
          <button
            type="button"
            class="switch"
            :class="{ on: appSettings.settings.autoCheckUpdate }"
            :aria-checked="appSettings.settings.autoCheckUpdate"
            :disabled="appSettings.busy"
            :aria-label="t('general.autoCheck')"
            @click="appSettings.set({ autoCheckUpdate: !appSettings.settings.autoCheckUpdate })"
          />
        </label>
      </div>
    </section>

    <section>
      <h2>{{ t('general.backupTitle') }}</h2>
      <div class="surface-card backup-panel">
        <div class="backup-intro"><strong>{{ t('general.encryptedBackup') }}</strong><p>{{ t('general.backupHint') }}</p></div>
        <div class="backup-grid">
          <div class="backup-action">
            <strong>{{ t('general.saveLocal') }}</strong>
            <input v-model="backupPassword" type="password" autocomplete="new-password" :placeholder="t('general.passwordPlaceholder')" :aria-label="t('general.passwordLabel')" />
            <input v-model="backupConfirm" type="password" autocomplete="new-password" :placeholder="t('general.confirmPlaceholder')" :aria-label="t('general.confirmLabel')" />
            <button type="button" :disabled="backupBusy" @click="createBackup">{{ t('general.saveBackup') }}</button>
          </div>
          <div class="backup-action">
            <strong>{{ t('general.restoreLocal') }}</strong>
            <input v-model="restorePassword" type="password" autocomplete="off" :placeholder="t('general.restorePlaceholder')" :aria-label="t('general.restoreLabel')" />
            <button type="button" :disabled="backupBusy" @click="previewBackup">{{ t('general.chooseFile') }}</button>
          </div>
        </div>
        <div class="webdav-backup">
          <strong>{{ t('general.webdavTitle') }}</strong>
          <p>{{ t('general.webdavHint') }}</p>
          <div class="webdav-form">
            <label class="webdav-field wide"><span>{{ t('general.webdavUrl') }}</span><input v-model="webdavAddress" type="url" spellcheck="false" autocomplete="off" placeholder="https://dav.example.com/dav" /></label>
            <label class="webdav-field"><span>{{ t('common.username') }}</span><input v-model="webdavUsername" spellcheck="false" autocomplete="username" :placeholder="t('general.webdavUserPlaceholder')" /></label>
            <label class="webdav-field"><span>{{ t('common.password') }}</span><span class="webdav-secret"><input v-model="webdavPassword" :type="webdavPasswordVisible ? 'text' : 'password'" autocomplete="off" :placeholder="t('general.webdavPasswordPlaceholder')" /><button type="button" class="webdav-eye" :class="{ active: webdavPasswordVisible }" :aria-label="webdavPasswordVisible ? t('general.hideWebdavPassword') : t('general.showWebdavPassword')" @click.prevent="webdavPasswordVisible = !webdavPasswordVisible"><AppIcon name="eye" :size="16" /></button></span></label>
            <label class="webdav-field"><span>{{ t('general.filePath') }}</span><input v-model="webdavFilePath" spellcheck="false" autocomplete="off" :placeholder="webdavDefaultPath" /></label>
            <label class="webdav-field"><span>{{ t('general.passphrase') }}</span><span class="webdav-secret"><input v-model="webdavPassphrase" :type="webdavPassphraseVisible ? 'text' : 'password'" autocomplete="new-password" :placeholder="t('general.passphrasePlaceholder')" /><button type="button" class="webdav-eye" :class="{ active: webdavPassphraseVisible }" :aria-label="webdavPassphraseVisible ? t('general.hidePassphrase') : t('general.showPassphrase')" @click.prevent="webdavPassphraseVisible = !webdavPassphraseVisible"><AppIcon name="eye" :size="16" /></button></span></label>
          </div>
          <p v-if="webdavFileUrl" class="webdav-target">{{ t('general.remoteFile') }}<code>{{ webdavFileUrl }}</code>{{ t('general.overwriteNote') }}</p>
          <div class="webdav-actions"><button type="button" :disabled="backupBusy || !webdavFileUrl" @click="uploadWebDav">{{ t('general.upload') }}</button><button type="button" :disabled="backupBusy || !webdavFileUrl" @click="previewWebDav">{{ t('general.downloadPreview') }}</button></div>
        </div>
        <div v-if="backupPreview" class="backup-preview" :class="{ incompatible: !backupPreview.compatible }">
          <strong>{{ t('general.previewTitle') }}</strong>
          <span>{{ t('general.backupVersion', [backupPreview.appVersion, new Date(backupPreview.createdAt).toLocaleString(locale)]) }}</span>
          <span>{{ t('general.backupCounts', [backupPreview.profileCount, backupPreview.subscriptionSourceCount, backupPreview.fileCount]) }}</span>
          <span>{{ t('general.backupChanges', [backupPreview.replaceCount, backupPreview.addCount, backupPreview.removeCount]) }}</span>
          <span>{{ t('general.backupExtras', [backupPreview.includesOverrides ? t('general.included') : t('common.none'), backupPreview.includesSubStore ? t('general.included') : t('common.none')]) }}</span>
          <span>{{ backupPreview.compatibilityMessage }}</span>
          <label v-if="backupPreview.compatible"><input v-model="restoreConfirmed" type="checkbox" /> {{ t('general.restoreAck') }}</label>
          <button v-if="backupPreview.compatible" type="button" :disabled="backupBusy || !restoreConfirmed" @click="restoreBackup">{{ t('general.restoreConfirm') }}</button>
        </div>
      </div>
      <p v-if="backupError" class="inline-error" role="alert">{{ backupError }}</p>
      <p v-if="backupNotice" class="setting-help" role="status">{{ backupNotice }}</p>
    </section>

    <section>
      <h2>{{ t('general.delayTest') }}</h2>
      <div class="surface-card preference-list delay-preferences">
        <label>
          <span>
            <strong>{{ t('general.urlSource') }}</strong>
          </span>
          <AppSelect v-model="delayScope" :options="delayScopeOptions" :label="t('general.urlSource')" />
        </label>
        <label>
          <span>
            <strong>{{ t('general.globalUrl') }}</strong>
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
