<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import SurfaceCard from '../components/SurfaceCard.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { useMitmStore } from '../stores/mitm'
import { useToast } from '../composables/use-toast'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { MITM_ACTION_LABELS } from '@shared/mitm'

const store = useMitmStore()
const toast = useToast()
const hostText = ref('')
const hostBaseline = ref('')
const deleteOpen = ref(false)
const regenerateOpen = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const state = computed(() => store.state)
const ca = computed(() => state.value.ca)
const hostDirty = computed(() => store.loaded && hostText.value.trim() !== hostBaseline.value.trim())
useUnsavedChanges('mitm-hostnames', '解密主机名', hostDirty)

/** Hostnames contributed by enabled modules (read-only here). */
const moduleHostnames = computed(() => {
  const own = new Set(state.value.settings.hostnames)
  return state.value.summary.hostnames.filter((host) => !own.has(host))
})

const statusText = computed(() => {
  if (state.value.active) return `解密已生效，共 ${state.value.summary.hostnames.length} 个主机名`
  return state.value.inactiveReason ?? '解密未生效'
})

const trustText = computed(() => {
  if (!ca.value) return ''
  if (ca.value.trusted === true) return '已信任'
  if (ca.value.trusted === false) return '未信任'
  return '无法检测信任状态'
})

function syncHosts(): void {
  const text = state.value.settings.hostnames.join('\n')
  hostText.value = text
  hostBaseline.value = text
}

watch(() => state.value.settings.hostnames, () => { if (!hostDirty.value) syncHosts() })

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString()
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

async function report(promise: Promise<string | null>, success: string, failure: string): Promise<void> {
  const error = await promise
  if (error) toast.error(failure, error)
  else toast.success(success)
}

async function toggleEnabled(): Promise<void> {
  const next = !state.value.settings.enabled
  await report(store.setEnabled(next), next ? 'HTTPS 解密已开启' : 'HTTPS 解密已关闭', '切换失败')
}

async function toggleHttp2(): Promise<void> {
  await report(store.setHttp2(!state.value.settings.http2), '已保存', '保存失败')
}

async function toggleSkipVerify(): Promise<void> {
  await report(store.setSkipVerify(!state.value.settings.skipServerCertVerify), '已保存', '保存失败')
}

async function saveHosts(): Promise<void> {
  const hosts = hostText.value.split(/[\n,]/).map((line) => line.trim()).filter(Boolean)
  const error = await store.setHostnames(hosts)
  if (error) toast.error('主机名保存失败', error)
  else {
    syncHosts()
    toast.success('主机名已保存')
  }
}

async function generate(): Promise<void> {
  regenerateOpen.value = false
  await report(store.generateCa(), '根证书已生成', '生成失败')
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
  if (state.value.settings.hostnames.includes(exclusion)) return
  await report(store.setHostnames([...state.value.settings.hostnames, exclusion]), `已排除 ${host}`, '保存失败')
}

onMounted(async () => {
  await store.refresh()
  syncHosts()
  await store.refreshRequests()
  timer = setInterval(() => void store.refreshRequests(), 2000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="page-shell feature-page mitm-view">
    <header class="feature-header">
      <div>
        <h1>解密</h1>
        <p>对列出的主机名做 HTTPS 解密，供「重写」修改请求与响应。只在规则模式下生效，未列出的连接原样转发。</p>
      </div>
      <AppIcon name="mitm" :size="25" />
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <section>
      <h2>HTTPS 解密</h2>
      <SurfaceCard class="mitm-card">
        <div class="setting-head">
          <div>
            <h3>启用 HTTPS 解密</h3>
            <p :class="{ 'mitm-ok': state.active }">{{ statusText }}</p>
          </div>
          <button type="button" class="switch" :class="{ on: state.settings.enabled }" role="switch" :aria-checked="state.settings.enabled" aria-label="启用 HTTPS 解密" :disabled="!!store.busy" @click="toggleEnabled" />
        </div>
        <div class="setting-head mitm-divided">
          <div>
            <h3>HTTP/2</h3>
            <p>与浏览器和源站协商 HTTP/2。遇到个别网站解密后异常时可以关闭，改用 HTTP/1.1。</p>
          </div>
          <button type="button" class="switch" :class="{ on: state.settings.http2 }" role="switch" :aria-checked="state.settings.http2" aria-label="HTTP/2" :disabled="!!store.busy" @click="toggleHttp2" />
        </div>
        <div class="setting-head mitm-divided">
          <div>
            <h3>跳过源站证书校验</h3>
            <p>连接源站时不检查证书。只在调试自签名服务时打开，会让中间人攻击无法被发现。</p>
          </div>
          <button type="button" class="switch" :class="{ on: state.settings.skipServerCertVerify }" role="switch" :aria-checked="state.settings.skipServerCertVerify" aria-label="跳过源站证书校验" :disabled="!!store.busy" @click="toggleSkipVerify" />
        </div>
      </SurfaceCard>
    </section>

    <section>
      <h2>根证书</h2>
      <SurfaceCard class="mitm-card">
        <template v-if="!ca">
          <p class="mitm-text">解密需要一张本机专属的根证书。证书和私钥只保存在这台电脑上，私钥存放在 Windows 凭据管理器中。</p>
          <div class="mitm-actions">
            <button type="button" class="mitm-primary" :disabled="!!store.busy" @click="generate">{{ store.busy === 'generate-ca' ? '生成中…' : '生成根证书' }}</button>
          </div>
        </template>
        <template v-else>
          <dl class="mitm-facts">
            <div><dt>名称</dt><dd>{{ ca.commonName }}</dd></div>
            <div><dt>有效期</dt><dd>{{ formatDate(ca.notBefore) }} 至 {{ formatDate(ca.notAfter) }}</dd></div>
            <div><dt>SHA-256</dt><dd class="mitm-mono">{{ ca.fingerprint }}</dd></div>
            <div><dt>系统信任</dt><dd :class="{ 'mitm-ok': ca.trusted === true, 'mitm-warn': ca.trusted === false }">{{ trustText }}</dd></div>
          </dl>
          <p v-if="ca.trusted !== true && state.trustSupported" class="mitm-hint">点击「安装并信任」后，Windows 会弹出安全警告，请选择「是」。证书只装到当前用户，不需要管理员权限。</p>
          <p class="mitm-hint">Firefox 默认不读取系统证书，需要在 about:config 中打开 security.enterprise_roots.enabled。</p>
          <div class="mitm-actions">
            <button v-if="state.trustSupported && ca.trusted !== true" type="button" class="mitm-primary" :disabled="!!store.busy" @click="install">{{ store.busy === 'install-ca' ? '等待确认…' : '安装并信任' }}</button>
            <button v-if="state.trustSupported && ca.trusted === true" type="button" class="mitm-secondary" :disabled="!!store.busy" @click="uninstall">移除信任</button>
            <button type="button" class="mitm-secondary" :disabled="!!store.busy" @click="exportCa">导出证书</button>
            <button type="button" class="mitm-secondary" :disabled="!!store.busy" @click="regenerateOpen = true">重新生成</button>
            <button type="button" class="mitm-danger" :disabled="!!store.busy" @click="deleteOpen = true">删除证书</button>
          </div>
        </template>
      </SurfaceCard>
    </section>

    <section>
      <h2>主机名</h2>
      <SurfaceCard class="mitm-card">
        <p class="mitm-hint">每行一个。支持 <code>*.example.com</code> 通配，<code>-host</code> 排除，<code>host:8443</code> 指定端口（默认只解密 443）。只添加确实需要重写的主机：银行、系统更新等启用证书锁定的应用解密后会无法连接。</p>
        <textarea v-model="hostText" class="mitm-textarea" spellcheck="false" placeholder="api.example.com&#10;*.example.org&#10;-login.example.org" />
        <p v-if="moduleHostnames.length" class="mitm-hint">来自模块：{{ moduleHostnames.join('，') }}</p>
        <div class="mitm-actions">
          <span v-if="hostDirty" class="unsaved-indicator">未保存</span>
          <button type="button" class="mitm-primary" :disabled="!!store.busy || !hostDirty" @click="saveHosts">保存</button>
        </div>
      </SurfaceCard>
    </section>

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
              <span v-for="action in entry.actions" :key="action" class="mitm-tag">{{ MITM_ACTION_LABELS[action] ?? action }}</span>
            </div>
            <p v-if="entry.error" class="mitm-error">
              {{ entry.error }}
              <button v-if="entry.method === 'TLS'" type="button" class="mitm-link" @click="excludeHost(entry.host)">不再解密 {{ entry.host }}</button>
            </p>
          </li>
        </ul>
      </SurfaceCard>
    </section>

    <ConfirmModal :open="regenerateOpen" title="重新生成根证书？" description="旧证书会从系统信任中移除，已导出到其它设备的旧证书也会失效。生成后需要重新安装并信任。" confirm-label="重新生成" :busy="!!store.busy" @close="regenerateOpen = false" @confirm="generate" />
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
.mitm-error { margin: 4px 0 0 52px; color: var(--app-danger); font-size: var(--font-size-2xs); overflow-wrap: anywhere; }
.mitm-link { margin-left: 6px; padding: 0; border: 0; background: transparent; color: var(--app-blue); font-size: inherit; cursor: pointer; }
</style>
