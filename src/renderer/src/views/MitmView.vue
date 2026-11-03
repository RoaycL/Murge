<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import SurfaceCard from '../components/SurfaceCard.vue'
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
const bulkOpen = ref(false)
const bulkText = ref('')
const bulkBaseline = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const state = computed(() => store.state)
const ca = computed(() => state.value.ca)
const settings = computed(() => state.value.settings)
const disabledSet = computed(() => new Set(settings.value.disabledHostnames ?? []))
const bulkDirty = computed(() => bulkOpen.value && bulkText.value.trim() !== bulkBaseline.value.trim())
const addDirty = computed(() => adding.value && newHost.value.trim() !== '')
useUnsavedChanges('mitm-hostnames', '解密主机名', computed(() => bulkDirty.value || addDirty.value))

/** Hostnames contributed by enabled modules (read-only here). */
const moduleHostnames = computed(() => {
  const own = new Set(settings.value.hostnames)
  return state.value.summary.hostnames.filter((host) => !own.has(host))
})

const statusText = computed(() => {
  if (state.value.active) return `解密已生效，共 ${state.value.summary.hostnames.length} 个主机名`
  return state.value.inactiveReason ?? '解密未生效'
})

const caStatus = computed(() => {
  if (!ca.value) return '尚未生成 CA 证书'
  if (ca.value.trusted === true) return 'CA 证书已被系统信任'
  if (ca.value.trusted === false) return 'CA 证书尚未被系统信任'
  return '无法检测 CA 证书的信任状态'
})

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString()
}

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

function openBulk(): void {
  const text = settings.value.hostnames.join('\n')
  bulkText.value = text
  bulkBaseline.value = text
  bulkOpen.value = true
}

async function saveBulk(): Promise<void> {
  const hosts = bulkText.value.split(/[\n,]/).map((line) => line.trim()).filter(Boolean)
  if (await saveList(hosts, [...disabledSet.value], '主机名已保存')) bulkOpen.value = false
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
    <header class="mitm-title">
      <div class="mitm-title-row">
        <h1>HTTPS 解密</h1>
        <button type="button" class="switch" :class="{ on: settings.enabled }" role="switch" :aria-checked="settings.enabled" aria-label="启用 HTTPS 解密" :disabled="!!store.busy" @click="toggleEnabled" />
      </div>
      <p>通过中间人攻击（MitM, man-in-the-middle）的方式解密 HTTPS 流量，供「重写」修改请求与响应。只在规则模式下生效，未列出的连接原样转发。</p>
      <p class="mitm-status-line" :class="{ 'mitm-ok': state.active }">{{ statusText }}</p>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <div class="mitm-columns">
      <div class="mitm-column">
        <section>
          <h2>CA 证书</h2>
          <SurfaceCard class="mitm-card">
            <div class="mitm-ca-head">
              <span class="mitm-ca-icon" :class="{ trusted: ca?.trusted === true }"><AppIcon name="certificate" :size="30" :stroke-width="1.5" /></span>
              <div>
                <strong>{{ ca ? ca.commonName : '未生成' }}</strong>
                <p :class="{ 'mitm-ok': ca?.trusted === true, 'mitm-warn': ca?.trusted === false }">{{ caStatus }}</p>
                <p v-if="ca" class="mitm-hint">有效期至 {{ formatDate(ca.notAfter) }}</p>
              </div>
            </div>
            <div class="mitm-ops">
              <span class="mitm-ops-label">操作：</span>
              <button type="button" class="mitm-op" :class="{ primary: !ca }" :disabled="!!store.busy" @click="requestGenerate">{{ store.busy === 'generate-ca' ? '生成中…' : '生成新证书' }}</button>
              <template v-if="ca && state.trustSupported">
                <button v-if="ca.trusted !== true" type="button" class="mitm-op primary" :disabled="!!store.busy" @click="install">{{ store.busy === 'install-ca' ? '等待确认…' : '将证书安装到系统' }}</button>
                <button v-else type="button" class="mitm-op" :disabled="!!store.busy" @click="uninstall">从系统移除信任</button>
              </template>
              <button v-if="ca" type="button" class="mitm-op" :disabled="!!store.busy" @click="exportCa">导出证书…</button>
              <button v-if="ca" type="button" class="mitm-op danger" :disabled="!!store.busy" @click="deleteOpen = true">删除证书</button>
            </div>
            <p v-if="!ca" class="mitm-hint">解密需要一张本机专属的根证书。证书和私钥只保存在这台电脑上，私钥存放在 Windows 凭据管理器中。</p>
            <p v-else-if="ca.trusted !== true && state.trustSupported" class="mitm-hint">安装时 Windows 会弹出安全警告，请选择「是」。证书只装到当前用户，不需要管理员权限。</p>
            <details v-if="ca" class="mitm-details">
              <summary>证书详情</summary>
              <dl class="mitm-facts">
                <div><dt>有效期</dt><dd>{{ formatDate(ca.notBefore) }} 至 {{ formatDate(ca.notAfter) }}</dd></div>
                <div><dt>SHA-256</dt><dd class="mitm-mono">{{ ca.fingerprint }}</dd></div>
              </dl>
              <p class="mitm-hint">Firefox 默认不读取系统证书，需要在 about:config 中打开 security.enterprise_roots.enabled。</p>
            </details>
          </SurfaceCard>
        </section>

        <section>
          <h2>选项</h2>
          <SurfaceCard class="mitm-card mitm-options">
            <label class="mitm-option">
              <input type="checkbox" :checked="settings.skipServerCertVerify" :disabled="!!store.busy" @change="toggleSkipVerify" />
              <span>
                <strong>进行 MitM 时跳过服务端证书验证</strong>
                <small>即使服务器证书无效也允许连接。只在调试自签名服务时打开，否则中间人攻击将无法被发现。</small>
              </span>
            </label>
            <label class="mitm-option">
              <input type="checkbox" :checked="settings.blockQuic" :disabled="!!store.busy" @change="toggleBlockQuic" />
              <span>
                <strong>自动屏蔽 QUIC</strong>
                <small>当 QUIC 连接（即 HTTP/3）命中 MitM 主机名列表时，自动阻止该 QUIC 连接，使连接回退至 HTTP/2 或 HTTP/1.1，以使其可被解密。</small>
              </span>
            </label>
            <label class="mitm-option">
              <input type="checkbox" :checked="settings.http2" :disabled="!!store.busy" @change="toggleHttp2" />
              <span>
                <strong>MitM over HTTP/2</strong>
                <small>使用 HTTP/2 协议进行解密，可在高并发下优化性能。个别网站解密后异常时可以关闭，改用 HTTP/1.1。</small>
              </span>
            </label>
          </SurfaceCard>
        </section>
      </div>

      <section class="mitm-column">
        <div class="mitm-section-head">
          <h2>MitM 主机名</h2>
          <div class="mitm-head-actions">
            <button v-if="!bulkOpen" type="button" class="mitm-link" :disabled="!!store.busy" @click="openBulk">批量编辑</button>
            <button v-if="!bulkOpen" type="button" class="mitm-icon-button" aria-label="添加主机名" title="添加主机名" :disabled="!!store.busy" @click="startAdd"><AppIcon name="add" :size="16" /></button>
          </div>
        </div>
        <SurfaceCard class="mitm-card mitm-hosts">
          <template v-if="bulkOpen">
            <textarea v-model="bulkText" class="mitm-textarea" spellcheck="false" placeholder="api.example.com&#10;*.example.org&#10;-login.example.org" />
            <div class="mitm-actions">
              <span v-if="bulkDirty" class="unsaved-indicator">未保存</span>
              <button type="button" class="mitm-secondary" @click="bulkOpen = false">取消</button>
              <button type="button" class="mitm-primary" :disabled="!!store.busy || !bulkDirty" @click="saveBulk">保存</button>
            </div>
          </template>
          <ul v-else class="mitm-host-list">
            <li v-for="host in settings.hostnames" :key="host" :class="{ off: disabledSet.has(host) }">
              <label>
                <input type="checkbox" :checked="!disabledSet.has(host)" :disabled="!!store.busy" :aria-label="`解密 ${host}`" @change="toggleHost(host)" />
                <span class="mitm-host-name">{{ host }}</span>
              </label>
              <span v-if="host.startsWith('-')" class="mitm-host-tag">排除</span>
              <button type="button" class="mitm-icon-button subtle" :aria-label="`删除 ${host}`" title="删除" :disabled="!!store.busy" @click="removeHost(host)"><AppIcon name="delete" :size="14" /></button>
            </li>
            <li v-for="host in moduleHostnames" :key="`module:${host}`" class="from-module">
              <label>
                <input type="checkbox" checked disabled :aria-label="`${host}（来自模块）`" />
                <span class="mitm-host-name">{{ host }}</span>
              </label>
              <span class="mitm-host-tag">模块</span>
            </li>
            <li v-if="adding" class="mitm-host-new">
              <input ref="newHostInput" v-model="newHost" class="mitm-input" spellcheck="false" placeholder="api.example.com 或 *.example.org" @keydown.enter.prevent="confirmAdd" @keydown.esc.prevent="cancelAdd" />
              <button type="button" class="mitm-primary" :disabled="!!store.busy" @click="confirmAdd">添加</button>
              <button type="button" class="mitm-secondary" @click="cancelAdd">取消</button>
            </li>
            <li v-if="!settings.hostnames.length && !moduleHostnames.length && !adding" class="mitm-host-empty">
              还没有主机名。点击右上角 + 添加。
            </li>
          </ul>
        </SurfaceCard>
        <p class="mitm-hint mitm-host-hint">只有该列表中的域名才会被解密，允许使用通配符（<code>*.example.com</code>），<code>-host</code> 排除，<code>host:8443</code> 指定端口（默认只解密 443）。部分应用有严格的安全策略，仅允许特定的 CA 证书，无法使用 MitM 进行解密。</p>
      </section>
    </div>

    <section>
      <div class="mitm-section-head">
        <h2>最近解密的请求</h2>
        <button type="button" class="mitm-secondary" :disabled="!store.requests.length" @click="store.clearRequests">清空</button>
      </div>
      <SurfaceCard class="mitm-card mitm-requests">
        <p v-if="!store.requests.length" class="entity-empty">还没有经过解密或重写的请求。</p>
        <ul v-else>
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
              <button v-if="entry.method === 'TLS'" type="button" class="mitm-link" @click="excludeHost(entry.host)">不再解密 {{ entry.host }}</button>
            </p>
          </li>
        </ul>
      </SurfaceCard>
    </section>

    <ConfirmModal :open="regenerateOpen" title="生成新证书？" description="旧证书会从系统信任中移除，已导出到其它设备的旧证书也会失效。生成后需要重新安装到系统。" confirm-label="生成新证书" :busy="!!store.busy" @close="regenerateOpen = false" @confirm="generate" />
    <ConfirmModal :open="deleteOpen" title="删除根证书？" description="将移除系统信任并删除证书与私钥，HTTPS 解密随即停止。" confirm-label="删除" :busy="!!store.busy" @close="deleteOpen = false" @confirm="remove" />
  </div>
</template>

<style scoped>
.mitm-view section { margin-top: 24px; }
.mitm-view h2 { margin: 0 0 11px; color: var(--app-pink); font-size: var(--font-size-md); font-weight: var(--font-weight-semibold); }
.mitm-section-head { display: flex; align-items: center; justify-content: space-between; }
.mitm-card { display: grid; gap: var(--space-4); padding: 14px 16px; border-radius: var(--radius-md); }
.mitm-divided { padding-top: 12px; border-top: 1px solid var(--app-divider); }
.mitm-text { margin: 0; font-size: var(--font-size-sm); line-height: 1.5; }
.mitm-hint { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.mitm-hint code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mitm-ok { color: var(--app-green) !important; }
.mitm-warn { color: var(--app-warning); }
.mitm-facts { display: grid; gap: 0; margin: 0; }
.mitm-facts div { display: flex; justify-content: space-between; gap: var(--space-5); padding: 7px 0; border-bottom: 1px solid var(--app-divider); font-size: var(--font-size-xs); }
.mitm-facts div:last-child { border-bottom: 0; }
.mitm-facts dt { flex: none; color: var(--app-muted); }
.mitm-facts dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.mitm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: var(--font-size-2xs); }
.mitm-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.mitm-primary, .mitm-secondary, .mitm-danger {
  min-height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
  cursor: pointer;
}
.mitm-primary { background: var(--app-blue); color: var(--app-on-accent); }
.mitm-secondary { background: var(--app-fill); color: inherit; }
.mitm-danger { background: transparent; color: var(--app-danger); }
.mitm-primary:disabled, .mitm-secondary:disabled, .mitm-danger:disabled { opacity: 0.55; cursor: default; }
.mitm-textarea {
  width: 100%;
  min-height: 110px;
  padding: 8px 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  color: inherit;
  font-size: var(--font-size-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
.mitm-requests ul { margin: 0; padding: 0; list-style: none; max-height: 420px; overflow: auto; }
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
.mitm-link { margin-left: 6px; padding: 0; border: 0; background: transparent; color: var(--app-blue); font-size: inherit; cursor: pointer; }
.mitm-title { margin-bottom: 4px; }
.mitm-title-row { display: flex; align-items: center; gap: var(--space-4); }
.mitm-title h1 { margin: 0; font-size: var(--font-size-2xl, 22px); font-weight: var(--font-weight-semibold); }
.mitm-title p { margin: 6px 0 0; color: var(--app-muted); font-size: var(--font-size-sm); line-height: 1.5; }
.mitm-title .mitm-status-line { margin-top: 4px; font-size: var(--font-size-xs); }
.mitm-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 20px; align-items: start; }
.mitm-column { min-width: 0; }
@media (max-width: 900px) { .mitm-columns { grid-template-columns: minmax(0, 1fr); } }
.mitm-ca-head { display: flex; align-items: center; gap: var(--space-4); }
.mitm-ca-head strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); overflow-wrap: anywhere; }
.mitm-ca-head p { margin: 2px 0 0; font-size: var(--font-size-xs); }
.mitm-ca-icon { display: grid; flex: none; place-items: center; width: 48px; height: 48px; border-radius: var(--radius-md); background: var(--app-fill); color: var(--app-muted); }
.mitm-ca-icon.trusted { color: var(--app-green); }
.mitm-ops { display: grid; gap: 7px; }
.mitm-ops-label { color: var(--app-muted); font-size: var(--font-size-xs); }
.mitm-op { width: 100%; min-height: 30px; padding: 0 12px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: var(--app-surface-solid); color: inherit; font-size: var(--font-size-sm); cursor: pointer; }
.mitm-op:hover:not(:disabled) { background: var(--app-fill); }
.mitm-op.primary { border-color: transparent; background: var(--app-blue); color: var(--app-on-accent); }
.mitm-op.danger { color: var(--app-danger); }
.mitm-op:disabled { opacity: 0.55; cursor: default; }
.mitm-details summary { color: var(--app-muted); font-size: var(--font-size-xs); cursor: pointer; }
.mitm-details .mitm-facts { margin-top: 6px; }
.mitm-details .mitm-hint { margin-top: 6px; }
.mitm-options { gap: 14px; }
.mitm-option { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.mitm-option input, .mitm-host-list input[type='checkbox'] { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--app-blue); }
.mitm-option span { display: grid; gap: 3px; }
.mitm-option strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); }
.mitm-option small { color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.mitm-head-actions { display: flex; align-items: center; gap: var(--space-3); margin-bottom: 11px; }
.mitm-icon-button { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--radius-control); background: var(--app-fill); color: inherit; cursor: pointer; }
.mitm-icon-button.subtle { background: transparent; color: var(--app-muted); opacity: 0; }
.mitm-host-list li:hover .mitm-icon-button.subtle, .mitm-icon-button.subtle:focus-visible { opacity: 1; }
.mitm-icon-button:disabled { opacity: 0.55; cursor: default; }
.mitm-hosts { padding: 4px 0; min-height: 260px; align-content: start; }
.mitm-hosts > .mitm-textarea, .mitm-hosts > .mitm-actions { margin: 8px 12px; width: auto; }
.mitm-hosts .mitm-textarea { min-height: 240px; }
.mitm-host-list { margin: 0; padding: 0; list-style: none; max-height: 460px; overflow: auto; }
.mitm-host-list li { display: flex; align-items: center; gap: var(--space-3); min-height: 32px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.mitm-host-list li:last-child { border-bottom: 0; }
.mitm-host-list label { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0; cursor: pointer; }
.mitm-host-list input[type='checkbox'] { margin: 0; }
.mitm-host-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: var(--font-size-xs); }
.mitm-host-list li.off .mitm-host-name, .mitm-host-list li.from-module .mitm-host-name { color: var(--app-muted); }
.mitm-host-list li.from-module label { cursor: default; }
.mitm-host-tag { flex: none; padding: 0 6px; border-radius: var(--radius-sm); background: var(--app-fill); color: var(--app-muted); font-size: var(--font-size-2xs); }
.mitm-host-new { padding: 6px 10px !important; }
.mitm-host-new .mitm-primary, .mitm-host-new .mitm-secondary { min-height: 26px; padding: 0 10px; }
.mitm-host-empty { justify-content: center; min-height: 120px !important; color: var(--app-muted); font-size: var(--font-size-xs) !important; }
.mitm-input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: var(--app-surface-solid); color: inherit; font-size: var(--font-size-xs); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mitm-host-hint { margin-top: 8px; }
.mitm-link:disabled { opacity: 0.55; cursor: default; }
</style>
