<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useDialogFocus } from '../composables/use-dialog-focus'
import AppIcon from '../components/AppIcon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useMitmStore } from '../stores/mitm'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { mitmActionLabel } from '@shared/mitm'

const store = useMitmStore()
const toast = useToast()
const deleteOpen = ref(false)
const regenerateOpen = ref(false)
const adding = ref(false)
const newHost = ref('')
const newHostInput = ref<HTMLInputElement | null>(null)
const requestsOpen = ref(false)
const requestsDialog = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const state = computed(() => store.state)
const ca = computed(() => state.value.ca)
const settings = computed(() => state.value.settings)
const disabledSet = computed(() => new Set(settings.value.disabledHostnames ?? []))
const addDirty = computed(() => adding.value && newHost.value.trim() !== '')
useUnsavedChanges('mitm-hostnames', '解密主机名', addDirty)
useDialogFocus(requestsOpen, requestsDialog, () => { requestsOpen.value = false })

/** Hostnames contributed by enabled modules (read-only here). */
const moduleHostnames = computed(() => {
  const own = new Set(settings.value.hostnames)
  return state.value.summary.hostnames.filter((host) => !own.has(host))
})

/** Shown only when the switch is on but decryption cannot run yet. */
const inactiveText = computed(() => {
  if (!settings.value.enabled || state.value.active) return null
  return state.value.inactiveReason ?? '解密未生效'
})

const caStatus = computed(() => {
  if (!ca.value) return '尚未生成 CA 证书'
  if (ca.value.trusted === true) return 'CA 证书已被系统信任'
  if (ca.value.trusted === false) return 'CA 证书尚未被系统信任'
  return '无法检测 CA 证书的信任状态'
})

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

async function report(promise: Promise<string | null>, success: string, failure: string): Promise<boolean> {
  const error = await promise
  if (error) toast.error(failure, error)
  else toast.success(success)
  return !error
}

async function toggleEnabled(): Promise<void> {
  const next = !settings.value.enabled
  await report(store.setEnabled(next), next ? 'HTTPS 解密已开启' : 'HTTPS 解密已关闭', '切换失败')
}

async function toggleHttp2(): Promise<void> {
  await report(store.setHttp2(!settings.value.http2), '已保存', '保存失败')
}

async function toggleBlockQuic(): Promise<void> {
  await report(store.setBlockQuic(!settings.value.blockQuic), '已保存', '保存失败')
}

async function toggleSkipVerify(): Promise<void> {
  await report(store.setSkipVerify(!settings.value.skipServerCertVerify), '已保存', '保存失败')
}

function saveList(hosts: string[], disabled: string[], success: string): Promise<boolean> {
  return report(store.setHostnames(hosts, disabled.filter((host) => hosts.includes(host))), success, '主机名保存失败')
}

async function toggleHost(host: string): Promise<void> {
  const disabled = new Set(disabledSet.value)
  if (disabled.has(host)) disabled.delete(host)
  else disabled.add(host)
  await saveList(settings.value.hostnames, [...disabled], disabled.has(host) ? `已停用 ${host}` : `已启用 ${host}`)
}

async function removeHost(host: string): Promise<void> {
  await saveList(settings.value.hostnames.filter((item) => item !== host), [...disabledSet.value], `已删除 ${host}`)
}

async function startAdd(): Promise<void> {
  adding.value = true
  newHost.value = ''
  await nextTick()
  newHostInput.value?.focus()
}

function cancelAdd(): void {
  adding.value = false
  newHost.value = ''
}

async function confirmAdd(): Promise<void> {
  const entries = newHost.value.split(/[\s,]+/).map((item) => item.trim().toLowerCase()).filter(Boolean)
  if (!entries.length) {
    cancelAdd()
    return
  }
  const hosts = [...settings.value.hostnames]
  for (const entry of entries) if (!hosts.includes(entry)) hosts.push(entry)
  if (await saveList(hosts, [...disabledSet.value], entries.length > 1 ? `已添加 ${entries.length} 个主机名` : `已添加 ${entries[0]}`)) cancelAdd()
}

async function generate(): Promise<void> {
  regenerateOpen.value = false
  await report(store.generateCa(), '根证书已生成', '生成失败')
}

function requestGenerate(): void {
  if (ca.value) regenerateOpen.value = true
  else void generate()
}

async function install(): Promise<void> {
  await report(store.installCa(), '根证书已信任', '安装失败')
}

async function uninstall(): Promise<void> {
  await report(store.uninstallCa(), '已移除系统信任', '移除失败')
}

async function remove(): Promise<void> {
  deleteOpen.value = false
  await report(store.deleteCa(), '根证书已删除', '删除失败')
}

async function exportCa(): Promise<void> {
  const error = await store.exportCa()
  if (error) toast.error('导出失败', error)
}

async function excludeHost(host: string): Promise<void> {
  const exclusion = `-${host}`
  if (settings.value.hostnames.includes(exclusion)) return
  await saveList([...settings.value.hostnames, exclusion], [...disabledSet.value], `已排除 ${host}`)
}

onMounted(async () => {
  await store.refresh()
  await store.refreshRequests()
  timer = setInterval(() => void store.refreshRequests(), 2000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="page-shell feature-page mitm-view">
    <header class="surge-title">
      <div class="surge-title-row">
        <h1>HTTPS 解密</h1>
        <button type="button" class="switch surge-switch" :class="{ on: settings.enabled }" role="switch" :aria-checked="settings.enabled" aria-label="启用 HTTPS 解密" :disabled="!!store.busy" @click="toggleEnabled" />
      </div>
      <p>通过中间人攻击（MitM, man-in-the-middle）的方式解密 HTTPS 流量。</p>
      <p v-if="inactiveText" class="surge-warn">{{ inactiveText }}</p>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="mitm-columns">
      <div class="mitm-left">
        <section class="surge-section">
          <h2 class="tone-orange">CA 证书</h2>
          <div class="mitm-ca">
            <svg class="mitm-ca-icon" viewBox="0 0 40 46" aria-hidden="true">
              <defs>
                <linearGradient id="mitm-ca-paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3aa0ff" /><stop offset="1" stop-color="#1572e8" /></linearGradient>
                <linearGradient id="mitm-ca-seal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd54a" /><stop offset="1" stop-color="#f5a623" /></linearGradient>
              </defs>
              <rect x="2" y="1" width="34" height="36" rx="3" fill="url(#mitm-ca-paper)" />
              <rect x="2" y="1" width="34" height="5" rx="2" fill="#0d5fc9" opacity=".55" />
              <rect x="8" y="12" width="22" height="2.6" rx="1.3" fill="#fff" opacity=".9" />
              <rect x="8" y="18" width="16" height="2.6" rx="1.3" fill="#fff" opacity=".9" />
              <rect x="8" y="24" width="12" height="2.6" rx="1.3" fill="#fff" opacity=".9" />
              <path d="M24 36 l-3 9 4-2 3 3 1-9z M32 36 l3 9-4-2-3 3-1-9z" fill="#e2463b" />
              <circle cx="28" cy="32" r="7.5" :fill="ca?.trusted === true ? 'url(#mitm-ca-seal)' : '#c4c8cf'" />
              <circle cx="28" cy="32" r="4.6" fill="none" stroke="#fff" stroke-width="1.2" opacity=".75" />
            </svg>
            <div class="mitm-ca-text">
              <strong :title="ca?.fingerprint ? `SHA-256 ${ca.fingerprint}` : undefined">{{ ca ? ca.commonName : '尚未生成 CA 证书' }}</strong>
              <small :class="{ 'surge-warn': ca?.trusted === false }">{{ ca ? caStatus : '解密前需要先生成一张本机专属的根证书' }}</small>
            </div>
          </div>
          <div class="mitm-ops">
            <span>操作：</span>
            <div class="mitm-ops-stack">
              <button type="button" class="surge-button" :disabled="!!store.busy" @click="requestGenerate">{{ store.busy === 'generate-ca' ? '生成中…' : '生成新证书' }}</button>
              <template v-if="ca && state.trustSupported">
                <button v-if="ca.trusted !== true" type="button" class="surge-button" :disabled="!!store.busy" @click="install">{{ store.busy === 'install-ca' ? '等待确认…' : '将证书安装到系统' }}</button>
                <button v-else type="button" class="surge-button" :disabled="!!store.busy" @click="uninstall">从系统中移除证书</button>
              </template>
              <button type="button" class="surge-button" :disabled="!!store.busy || !ca" @click="exportCa">导出证书</button>
              <button type="button" class="surge-button danger" :disabled="!!store.busy || !ca" @click="deleteOpen = true">删除证书</button>
            </div>
          </div>
        </section>

        <section class="surge-section">
          <h2 class="tone-green">选项</h2>
          <label class="surge-check">
            <input type="checkbox" :checked="settings.skipServerCertVerify" :disabled="!!store.busy" @change="toggleSkipVerify" />
            <span>进行 MitM 时跳过服务端证书验证</span>
            <small>即使服务器证书无效也允许连接。</small>
          </label>
          <label class="surge-check">
            <input type="checkbox" :checked="settings.blockQuic" :disabled="!!store.busy" @change="toggleBlockQuic" />
            <span>自动屏蔽 QUIC</span>
            <small>当 QUIC 连接（即 HTTP/3）命中 MITM 主机名列表时，自动阻止该 QUIC 连接，使得连接回退至 HTTP/2 或 HTTP/1.1，以使得其可被 MITM。</small>
          </label>
          <label class="surge-check">
            <input type="checkbox" :checked="settings.http2" :disabled="!!store.busy" @change="toggleHttp2" />
            <span>MitM over HTTP/2</span>
            <small>使用 HTTP/2 协议进行 MITM 解密，可在高并发下优化性能。</small>
          </label>
        </section>
      </div>

      <div class="mitm-right">
        <div class="mitm-hostbox">
          <header>
            <span>MitM 主机名</span>
            <button type="button" class="mitm-plus" aria-label="添加主机名" title="添加主机名" :disabled="!!store.busy" @click="startAdd"><AppIcon name="add" :size="11" :stroke-width="3" /></button>
          </header>
          <ul>
            <li v-for="host in settings.hostnames" :key="host" :class="{ off: disabledSet.has(host) }">
              <label>
                <input type="checkbox" :checked="!disabledSet.has(host)" :disabled="!!store.busy" :aria-label="`解密 ${host}`" @change="toggleHost(host)" />
                <span>{{ host }}</span>
              </label>
              <button type="button" class="mitm-row-delete" :aria-label="`删除 ${host}`" title="删除" :disabled="!!store.busy" @click="removeHost(host)"><AppIcon name="close" :size="12" /></button>
            </li>
            <li v-for="host in moduleHostnames" :key="`module:${host}`" class="from-module" title="来自模块，在「重写」页的模块中管理">
              <label>
                <input type="checkbox" checked disabled :aria-label="`${host}（来自模块）`" />
                <span>{{ host }}</span>
              </label>
              <small>模块</small>
            </li>
            <li v-if="adding" class="mitm-row-new">
              <input ref="newHostInput" v-model="newHost" spellcheck="false" placeholder="example.com，可用空格分隔多个" @keydown.enter.prevent="confirmAdd" @keydown.esc.prevent="cancelAdd" @blur="confirmAdd" />
            </li>
          </ul>
        </div>
        <p class="surge-hint">只有该列表中的域名才会被解密，允许使用通配符。部分应用有严格的安全策略，仅允许特定的 CA 证书，无法使用 MitM 进行解密。</p>
      </div>
    </div>

    <p class="surge-hint mitm-footer">
      <button type="button" class="surge-link" @click="requestsOpen = true">最近解密的请求<template v-if="store.requests.length">（{{ store.requests.length }}）</template>…</button>
    </p>

    <Teleport to="body">
      <div v-if="requestsOpen" class="modal-shade" role="presentation" @click.self="requestsOpen = false">
        <section ref="requestsDialog" class="mitm-requests-modal" role="dialog" aria-modal="true" aria-label="最近解密的请求">
          <header>
            <h2>最近解密的请求</h2>
            <div>
              <button type="button" class="surge-button compact" :disabled="!store.requests.length" @click="store.clearRequests">清空</button>
              <button type="button" class="icon-control" aria-label="关闭" @click="requestsOpen = false"><AppIcon name="close" /></button>
            </div>
          </header>
          <p v-if="!store.requests.length" class="entity-empty">还没有经过解密或重写的请求。</p>
          <ul v-else class="mitm-requests">
            <li v-for="entry in store.requests" :key="entry.id" :class="{ failed: !!entry.error }">
              <div class="mitm-request-line">
                <span class="mitm-method">{{ entry.method }}</span>
                <span class="mitm-url" :title="entry.url">{{ entry.url }}</span>
                <span class="mitm-status">{{ entry.status ?? '—' }}</span>
              </div>
              <div class="mitm-request-meta">
                <span>{{ formatTime(entry.time) }}</span>
                <span>{{ entry.durationMs }} ms</span>
                <span v-for="action in entry.actions" :key="action" class="mitm-tag" :class="{ 'mitm-tag-error': action.startsWith('script-error:') }">{{ mitmActionLabel(action) }}</span>
              </div>
              <details v-if="entry.scriptLogs?.length" class="mitm-script-logs">
                <summary>脚本日志（{{ entry.scriptLogs.length }}）</summary>
                <pre>{{ entry.scriptLogs.join('\n') }}</pre>
              </details>
              <p v-if="entry.error" class="mitm-error">
                {{ entry.error }}
                <button v-if="entry.method === 'TLS'" type="button" class="surge-link" @click="excludeHost(entry.host)">不再解密 {{ entry.host }}</button>
              </p>
            </li>
          </ul>
        </section>
      </div>
    </Teleport>

    <ConfirmModal :open="regenerateOpen" title="生成新证书？" description="旧证书会从系统中移除，已导出到其它设备的旧证书也会失效。生成后需要重新安装到系统。" confirm-label="生成新证书" :busy="!!store.busy" @close="regenerateOpen = false" @confirm="generate" />
    <ConfirmModal :open="deleteOpen" title="删除根证书？" description="将从系统中移除并删除证书与私钥，HTTPS 解密随即停止。" confirm-label="删除" :busy="!!store.busy" @close="deleteOpen = false" @confirm="remove" />
  </div>
</template>

<style scoped>
.mitm-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: stretch; margin-top: 22px; }
@media (max-width: 860px) { .mitm-columns { grid-template-columns: minmax(0, 1fr); } }
.mitm-left { display: grid; align-content: start; gap: 18px; min-width: 0; }
.mitm-right { display: flex; flex-direction: column; min-width: 0; }
.mitm-ca { display: flex; align-items: center; gap: 10px; padding: 4px 0 0 24px; }
.mitm-ca-icon { flex: none; width: 40px; height: 46px; }
.mitm-ca-text { display: grid; gap: 3px; min-width: 0; }
.mitm-ca-text strong { overflow: hidden; font-size: var(--font-size-md); font-weight: var(--font-weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.mitm-ca-text small { color: var(--app-muted); font-size: var(--font-size-xs); }
.mitm-ops { display: flex; align-items: flex-start; gap: 10px; margin-top: 18px; padding-left: 24px; font-size: var(--font-size-md); }
.mitm-ops > span { flex: none; line-height: 24px; }
.mitm-ops-stack { display: grid; gap: 9px; width: min(182px, 100%); }
.mitm-hostbox { display: flex; flex: 1; flex-direction: column; min-height: 420px; overflow: hidden; border: 1px solid var(--app-divider); border-radius: 4px; background: color-mix(in srgb, var(--app-surface-solid) 55%, transparent); }
.mitm-hostbox header { display: flex; flex: none; align-items: center; justify-content: space-between; height: 26px; padding: 0 7px 0 14px; border-bottom: 1px solid var(--app-divider); color: var(--app-muted); background: var(--app-fill-subtle); font-size: var(--font-size-md); }
.mitm-plus { display: grid; place-items: center; width: 14px; height: 14px; padding: 0; border: 0; border-radius: 50%; color: var(--app-surface-solid); background: var(--app-muted); cursor: pointer; }
.mitm-plus:disabled { opacity: 0.5; cursor: default; }
.mitm-hostbox ul { flex: 1; margin: 0; padding: 5px 0; overflow: auto; list-style: none; }
.mitm-hostbox li { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px 0 13px; font-size: var(--font-size-md); }
.mitm-hostbox li label { display: flex; flex: 1; align-items: center; gap: 9px; min-width: 0; cursor: pointer; }
.mitm-hostbox li label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mitm-hostbox li input[type='checkbox'] { flex: none; width: 14px; height: 14px; margin: 0; accent-color: var(--app-blue); }
.mitm-hostbox li.off label span, .mitm-hostbox li.from-module label span { color: var(--app-muted); }
.mitm-hostbox li.from-module label { cursor: default; }
.mitm-hostbox li small { flex: none; color: var(--app-muted); font-size: var(--font-size-2xs); }
.mitm-row-delete { display: grid; flex: none; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; color: var(--app-muted); background: transparent; cursor: pointer; opacity: 0; }
.mitm-hostbox li:hover .mitm-row-delete, .mitm-row-delete:focus-visible { opacity: 1; }
.mitm-row-delete:hover { background: var(--app-fill); }
.mitm-row-new input { flex: 1; min-width: 0; height: 20px; padding: 0 6px; border: 1px solid var(--app-blue); border-radius: 3px; outline: 0; color: inherit; background: var(--app-surface-solid); font-size: var(--font-size-sm); }
.mitm-right .surge-hint { margin-top: 8px; }
.mitm-footer { margin-top: 16px; }
.mitm-requests-modal { display: flex; flex-direction: column; width: min(760px, calc(100vw - 48px)); max-height: min(620px, calc(100vh - 80px)); padding: 18px 20px; border: 1px solid var(--app-divider); border-radius: var(--radius-panel); color: var(--app-text); background: var(--app-popover); -webkit-backdrop-filter: var(--app-popover-filter); backdrop-filter: var(--app-popover-filter); box-shadow: 0 22px 70px rgba(0, 0, 0, 0.28); }
.mitm-requests-modal > header { display: flex; flex: none; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.mitm-requests-modal > header > div { display: flex; align-items: center; gap: 8px; }
.mitm-requests-modal h2 { margin: 0; font-size: var(--font-size-title); }
.mitm-requests { flex: 1; margin: 0; padding: 0; overflow: auto; list-style: none; }
.mitm-requests li { padding: 8px 0; border-bottom: 1px solid var(--app-divider); }
.mitm-requests li:last-child { border-bottom: 0; }
.mitm-request-line { display: flex; align-items: center; gap: var(--space-3); font-size: var(--font-size-xs); }
.mitm-method { flex: none; min-width: 44px; color: var(--app-muted); font-weight: var(--font-weight-medium); }
.mitm-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mitm-status { flex: none; color: var(--app-muted); }
.mitm-request-meta { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: 3px; padding-left: 52px; color: var(--app-muted); font-size: var(--font-size-2xs); }
.mitm-tag { padding: 0 6px; border-radius: var(--radius-sm); background: var(--app-fill); color: var(--app-blue); }
.mitm-tag-error { color: var(--app-danger); }
.mitm-script-logs { margin: 4px 0 0 52px; color: var(--app-muted); font-size: var(--font-size-2xs); }
.mitm-script-logs summary { cursor: pointer; }
.mitm-script-logs pre { max-height: 220px; margin: 4px 0 0; padding: 6px 8px; overflow: auto; border-radius: var(--radius-control); background: var(--app-fill-subtle); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.mitm-error { margin: 4px 0 0 52px; color: var(--app-danger); font-size: var(--font-size-2xs); overflow-wrap: anywhere; }
</style>
