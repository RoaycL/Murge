<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import DetailDrawer from './DetailDrawer.vue'
import AppSelect from './AppSelect.vue'
import { isTailscaleDnsSafeName, type LocalNode, type ProxyConfig } from '@shared/local'
import {
  configToYaml,
  emptyTailscaleForm,
  emptyWireGuardForm,
  parseProxiesYaml,
  tailscaleConfigFrom,
  tailscaleFormFrom,
  wireGuardConfigFrom,
  wireGuardFormFrom,
  wireGuardNeedsYaml,
  type NodeEditorKind,
  type TailscaleForm,
  type WireGuardForm
} from '../lib/local-node-form'

const props = defineProps<{
  open: boolean
  /** The node being edited; a new node when its id is empty. */
  node: LocalNode | null
  kind: NodeEditorKind
  groups: Array<{ name: string; type: string }>
  /** Policies usable as 经由 (dialer-proxy). */
  targets: string[]
  /** Names already used by other local nodes. */
  takenNames: string[]
  busy: boolean
  error: string | null
}>()
const emit = defineEmits<{ close: []; save: [node: LocalNode]; saveMany: [nodes: LocalNode[]] }>()

const mode = ref<NodeEditorKind>('wireguard')
const wg = ref<WireGuardForm>(emptyWireGuardForm())
const ts = ref<TailscaleForm>(emptyTailscaleForm())
const yamlText = ref('')
const groups = ref<string[]>([])
const tailnetRules = ref(true)
const formError = ref<string | null>(null)

const isNew = computed(() => !props.node?.id)
const title = computed(() => {
  if (!isNew.value) return props.node?.config.name ?? '编辑节点'
  return mode.value === 'tailscale' ? '添加 Tailscale' : mode.value === 'wireguard' ? '添加 WireGuard' : '添加节点'
})
const subtitle = computed(() => (mode.value === 'yaml' ? 'mihomo 节点 YAML' : mode.value === 'tailscale' ? 'Tailscale' : 'WireGuard'))

const dialerOptions = computed(() => [
  { value: '', label: '直接连接' },
  ...props.targets
    .filter((name) => !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'].includes(name) && name !== currentName.value)
    .map((name) => ({ value: name, label: name }))
])
const currentName = computed(() => (mode.value === 'tailscale' ? ts.value.name : mode.value === 'wireguard' ? wg.value.name : props.node?.config.name ?? '').trim())
const tsNameWarning = computed(() =>
  mode.value === 'tailscale' && tailnetRules.value && ts.value.name.trim() && !isTailscaleDnsSafeName(ts.value.name.trim())
    ? '名称含空格或 / ? # @ : 等字符，MagicDNS 无法使用此节点解析 *.ts.net。'
    : null
)

watch(
  () => [props.open, props.node, props.kind] as const,
  ([open]) => {
    if (!open) return
    formError.value = null
    const config = (props.node?.config ?? {}) as Record<string, unknown>
    const type = String(config.type ?? props.kind).toLowerCase()
    groups.value = [...(props.node?.groups ?? [])]
    tailnetRules.value = props.node?.tailnetRules ?? true
    yamlText.value = props.node?.config ? configToYaml(config) : 'name: 新节点\ntype: ss\nserver: example.com\nport: 443\ncipher: aes-128-gcm\npassword: ""\nudp: true\n'
    if (props.kind === 'yaml') mode.value = 'yaml'
    else if (type === 'tailscale') mode.value = 'tailscale'
    else if (type === 'wireguard' && !wireGuardNeedsYaml(config)) mode.value = 'wireguard'
    else mode.value = 'yaml'
    wg.value = type === 'wireguard' && props.node ? wireGuardFormFrom(config) : emptyWireGuardForm()
    ts.value = type === 'tailscale' && props.node ? tailscaleFormFrom(config) : emptyTailscaleForm()
  },
  { immediate: true }
)

function toggleGroup(name: string): void {
  groups.value = groups.value.includes(name) ? groups.value.filter((item) => item !== name) : [...groups.value, name]
}

function switchToYaml(): void {
  try {
    const config = buildConfig()
    yamlText.value = configToYaml(config)
  } catch {
    // Keep whatever YAML there is; the form had invalid input.
  }
  mode.value = 'yaml'
}

function buildConfig(): ProxyConfig {
  const base = (props.node?.config ?? {}) as Record<string, unknown>
  if (mode.value === 'wireguard') return wireGuardConfigFrom(wg.value, String(base.type).toLowerCase() === 'wireguard' ? base : {})
  if (mode.value === 'tailscale') return tailscaleConfigFrom(ts.value, String(base.type).toLowerCase() === 'tailscale' ? base : {})
  const parsed = parseProxiesYaml(yamlText.value)
  if (parsed.length !== 1) throw new Error('编辑已有节点时只能包含一个节点')
  return parsed[0]
}

function submit(): void {
  formError.value = null
  try {
    if (mode.value === 'yaml' && isNew.value) {
      const parsed = parseProxiesYaml(yamlText.value)
      if (parsed.length > 1) {
        const clash = parsed.find((config) => props.takenNames.includes(config.name))
        if (clash) throw new Error(`已有名为「${clash.name}」的本地节点`)
        emit('saveMany', parsed.map((config) => ({ id: '', enabled: true, config, groups: [...groups.value], tailnetRules: true })))
        return
      }
    }
    const config = buildConfig()
    if (props.takenNames.includes(config.name)) throw new Error(`已有名为「${config.name}」的本地节点`)
    emit('save', {
      id: props.node?.id ?? '',
      enabled: props.node?.enabled ?? true,
      config,
      groups: groups.value,
      tailnetRules: tailnetRules.value
    })
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <DetailDrawer :open="open" :title="title" :subtitle="subtitle" @close="emit('close')">
    <form class="node-editor" @submit.prevent="submit">
      <template v-if="mode === 'wireguard'">
        <div class="node-form-card">
          <label><span>名称</span><input v-model="wg.name" type="text" spellcheck="false" placeholder="家里 WireGuard" /></label>
          <label><span>服务器</span><input v-model="wg.server" type="text" spellcheck="false" placeholder="example.com 或 IP" /></label>
          <label><span>端口</span><input v-model="wg.port" type="text" inputmode="numeric" placeholder="51820" /></label>
        </div>
        <div class="node-form-card">
          <label><span>本机私钥</span><input v-model="wg.privateKey" type="password" spellcheck="false" autocomplete="off" placeholder="PrivateKey" /></label>
          <label><span>对端公钥</span><input v-model="wg.publicKey" type="text" spellcheck="false" placeholder="PublicKey" /></label>
          <label><span>预共享密钥</span><input v-model="wg.preSharedKey" type="password" spellcheck="false" autocomplete="off" placeholder="可选" /></label>
        </div>
        <div class="node-form-card">
          <label><span>隧道 IPv4</span><input v-model="wg.ip" type="text" spellcheck="false" placeholder="10.0.0.2/32" /></label>
          <label><span>隧道 IPv6</span><input v-model="wg.ipv6" type="text" spellcheck="false" placeholder="可选" /></label>
          <label><span>允许的 IP</span><input v-model="wg.allowedIps" type="text" spellcheck="false" placeholder="0.0.0.0/0, ::/0" /></label>
          <label><span>隧道内 DNS</span><input v-model="wg.dns" type="text" spellcheck="false" placeholder="可选，例如 1.1.1.1" /></label>
        </div>
        <div class="node-form-card">
          <label><span>MTU</span><input v-model="wg.mtu" type="text" inputmode="numeric" placeholder="默认 1408" /></label>
          <label><span>Keepalive（秒）</span><input v-model="wg.keepalive" type="text" inputmode="numeric" placeholder="可选，例如 25" /></label>
          <label><span>Reserved</span><input v-model="wg.reserved" type="text" spellcheck="false" placeholder="可选，WARP 用，如 1/2/3" /></label>
          <label><span>经由</span><span class="node-form-select"><AppSelect :model-value="wg.dialerProxy" :options="dialerOptions" label="经由" plain @update:model-value="(value: string) => (wg.dialerProxy = value)" /></span></label>
        </div>
        <p class="node-form-hint">填了“隧道内 DNS”时，经这个节点访问的域名会在隧道里解析。“允许的 IP”只填内网段时，这个节点只能访问这些地址。</p>
      </template>

      <template v-else-if="mode === 'tailscale'">
        <div class="node-form-card">
          <label><span>名称</span><input v-model="ts.name" type="text" spellcheck="false" placeholder="Tailscale" /></label>
          <label><span>Auth Key</span><input v-model="ts.authKey" type="password" spellcheck="false" autocomplete="off" placeholder="tskey-auth-…" /></label>
          <label><span>设备名</span><input v-model="ts.hostname" type="text" spellcheck="false" placeholder="murge" /></label>
          <label><span>控制服务器</span><input v-model="ts.controlUrl" type="text" spellcheck="false" placeholder="留空使用 Tailscale 官方；可填 Headscale" /></label>
        </div>
        <div class="node-form-card">
          <label><span>出口节点</span><input v-model="ts.exitNode" type="text" spellcheck="false" placeholder="可选，节点名或 100.x 地址" /></label>
          <label v-if="ts.exitNode.trim()" class="node-form-toggle"><span>使用出口节点时仍可访问局域网</span><button type="button" class="switch" :class="{ on: ts.exitNodeAllowLanAccess }" role="switch" :aria-checked="ts.exitNodeAllowLanAccess" aria-label="使用出口节点时仍可访问局域网" @click="ts.exitNodeAllowLanAccess = !ts.exitNodeAllowLanAccess" /></label>
          <label class="node-form-toggle"><span>接受子网路由</span><button type="button" class="switch" :class="{ on: ts.acceptRoutes }" role="switch" :aria-checked="ts.acceptRoutes" aria-label="接受子网路由" @click="ts.acceptRoutes = !ts.acceptRoutes" /></label>
          <label class="node-form-toggle"><span>临时设备（离线后自动移除）</span><button type="button" class="switch" :class="{ on: ts.ephemeral }" role="switch" :aria-checked="ts.ephemeral" aria-label="临时设备" @click="ts.ephemeral = !ts.ephemeral" /></label>
          <label><span>经由</span><span class="node-form-select"><AppSelect :model-value="ts.dialerProxy" :options="dialerOptions" label="经由" plain @update:model-value="(value: string) => (ts.dialerProxy = value)" /></span></label>
        </div>
        <div class="node-form-card">
          <label class="node-form-toggle"><span>自动添加 tailnet 规则<small>*.ts.net、100.64.0.0/10、fd7a:115c:a1e0::/48 走此节点，MagicDNS 也经由它解析</small></span><button type="button" class="switch" :class="{ on: tailnetRules }" role="switch" :aria-checked="tailnetRules" aria-label="自动添加 tailnet 规则" @click="tailnetRules = !tailnetRules" /></label>
        </div>
        <p v-if="tsNameWarning" class="node-form-error">{{ tsNameWarning }}</p>
        <p class="node-form-hint">Murge 会作为一台设备加入你的 tailnet，只负责出站：可以访问 tailnet 里的设备、子网路由和出口节点，其他设备不能通过它访问这台电脑。没有填 Auth Key 时，首次启动的登录链接会出现在“日志”页。</p>
      </template>

      <template v-else>
        <textarea v-model="yamlText" class="node-yaml" spellcheck="false" aria-label="节点 YAML" />
        <p class="node-form-hint">mihomo 的 proxies 格式，支持内核支持的所有协议。<template v-if="isNew">可以一次粘贴多个节点（列表或带 proxies: 的片段）。</template></p>
      </template>

      <section v-if="groups.length || props.groups.length" class="node-groups">
        <h3>加入策略组</h3>
        <div v-if="props.groups.length" class="node-group-list">
          <label v-for="group in props.groups" :key="group.name" class="surge-check"><input type="checkbox" :checked="groups.includes(group.name)" @change="toggleGroup(group.name)" />{{ group.name }}</label>
        </div>
        <p v-else class="node-form-hint">启动内核或选择订阅后可以选择策略组。</p>
      </section>

      <p v-if="formError || error" class="node-form-error" role="alert">{{ formError || error }}</p>
      <div class="node-editor-actions">
        <button v-if="mode !== 'yaml'" type="button" class="surge-button" @click="switchToYaml">以 YAML 编辑</button>
        <span class="spacer" />
        <button type="button" class="surge-button" :disabled="busy" @click="emit('close')">取消</button>
        <button type="submit" class="surge-button primary" :disabled="busy">{{ busy ? '保存中…' : '保存' }}</button>
      </div>
    </form>
  </DetailDrawer>
</template>

<style scoped>
.node-editor { display: grid; gap: 14px; }
.node-form-card { display: grid; padding: 0 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); }
.node-form-card label { display: grid; grid-template-columns: minmax(96px, 36%) 1fr; align-items: center; gap: 12px; min-height: 38px; border-top: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.node-form-card label:first-child { border-top: 0; }
.node-form-card label > span { display: grid; gap: 2px; }
.node-form-card label > span small { color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.4; }
.node-form-card input { min-width: 0; height: 30px; padding: 0; border: 0; background: transparent; color: var(--app-text); font-size: var(--font-size-sm); text-align: right; }
.node-form-card input::placeholder { color: var(--app-faint); }
.node-form-card input:focus { outline: none; }
.node-form-card label:focus-within { box-shadow: inset 0 -2px 0 var(--app-blue); }
.node-form-toggle .switch { justify-self: end; }
.node-form-card label.node-form-toggle { grid-template-columns: minmax(0, 1fr) auto; padding: 8px 0; }
.node-form-select { justify-self: end; width: max-content; max-width: 100%; }
.node-form-select :deep(.app-select.plain .app-select-trigger) { gap: 4px; font-size: var(--font-size-sm); font-weight: var(--font-weight-regular); color: var(--app-muted); }
.node-form-select :deep(.app-select.plain .trigger-chevron) { display: inline-block; }
.node-form-hint { margin: 0 4px; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.55; }
.node-form-error { margin: 0 4px; color: var(--app-danger); font-size: var(--font-size-xs); line-height: 1.5; }
.node-yaml { min-height: 280px; padding: 12px 14px; border: 1px solid var(--app-divider); border-radius: var(--radius-panel); background: var(--app-surface-solid); color: var(--app-text); font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; }
.node-groups h3 { margin: 0 0 8px 4px; color: var(--app-muted); font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.node-group-list { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 12px 14px; border-radius: var(--radius-panel); background: var(--app-surface-solid); font-size: var(--font-size-sm); }
.node-editor-actions { display: flex; align-items: center; gap: var(--space-3); }
.node-editor-actions .spacer { flex: 1; }
</style>
