<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLanStore } from '../stores/lan'
import { useTunStore } from '../stores/tun'
import { useTunConfigStore } from '../stores/tun-config'
import { lanAddresses } from '@shared/lan'
import { brand } from '@shared/brand'

/**
 * 网关模式 setup guide. mihomo has no DHCP server, so the app cannot hand out
 * leases the way Surge does. With TUN on and Windows IP forwarding enabled, a
 * device whose gateway is set to this PC by hand is routed into the TUN
 * adapter, where mihomo takes over its traffic (DNS included, via
 * dns-hijack). The 网关模式 switch turns the forwarding on through the
 * privileged TUN service (a UAC prompt when the service is unavailable); the
 * manual command stays as a fallback.
 */
const lan = useLanStore()
const tun = useTunStore()
const tunConfig = useTunConfigStore()
onMounted(() => {
  void lan.refresh()
  void lan.refreshGateway()
  void tunConfig.refresh()
})

const tunActive = computed(() => tun.status.phase === 'active')
const lanHosts = computed(() => lanAddresses(lan.addresses))
const primaryLan = computed(() => lanHosts.value[0]?.address ?? null)
const tunDevice = computed(() => tunConfig.config.device === 'Mihomo' ? `${brand.shortName} TUN` : tunConfig.config.device)
const lanAdapter = computed(() => lanHosts.value[0]?.name ?? 'WLAN')
const forwardingCommand = computed(() => `Set-NetIPInterface -InterfaceAlias "${lanAdapter.value}", "${tunDevice.value}" -AddressFamily IPv4 -Forwarding Enabled`)

const gatewayEnabled = computed(() => lan.gateway?.enabled ?? false)
const forwardingTargets = computed(() => {
  const names = (lan.gateway?.interfaces ?? []).map((entry) => `「${entry.name}」`)
  return names.length ? names.join('、') : `「${lanAdapter.value}」和「${tunDevice.value}」`
})
function toggleGateway(): void {
  void lan.setGateway(!gatewayEnabled.value, tunDevice.value)
}

const copied = ref('')
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = text
    setTimeout(() => { if (copied.value === text) copied.value = '' }, 1600)
  } catch {
    copied.value = ''
  }
}
</script>

<template>
  <section class="gateway-panel" aria-label="网关模式">
    <header class="gateway-head">
      <div>
        <h2>网关模式</h2>
        <p>让局域网内的手机、电视、游戏机等设备把网关指向本机，由 TUN 接管它们的全部流量。</p>
      </div>
      <div class="gateway-status" :class="{ active: gatewayEnabled && tunActive && primaryLan }">
        <i />
        <span>{{ !gatewayEnabled ? '未启用' : !tunActive ? '需先开启 TUN 模式' : primaryLan ? `网关地址 ${primaryLan}` : '未检测到局域网地址' }}</span>
      </div>
    </header>
    <ol>
      <li>
        <strong>开启 TUN 模式</strong>
        <span>{{ tunActive ? '已开启。' : '在概览打开「TUN 模式」开关。' }}</span>
      </li>
      <li>
        <strong>打开网关模式</strong>
        <span>打开后会自动为 {{ forwardingTargets }} 开启 Windows 转发，并添加一条只允许本地子网访问内核的防火墙规则，无需把网络改为「专用网络」。TUN 网卡重建后自动重新开启；关闭开关或退出 {{ brand.shortName }} 时自动恢复。</span>
        <button type="button" class="secondary-button" :disabled="lan.gatewayBusy" @click="toggleGateway">{{ lan.gatewayBusy ? '正在切换…' : gatewayEnabled ? '关闭网关模式' : '开启网关模式' }}</button>
        <span v-if="lan.gatewayError" class="gateway-error" role="alert">{{ lan.gatewayError }}</span>
      </li>
      <li>
        <strong>在设备上手动设置网络</strong>
        <span>把 IPv4 改为手动：IP 地址与本机同一网段且未被占用，子网掩码与本机一致，<b>路由器 / 网关</b>填 <b>{{ primaryLan ?? '本机局域网 IP' }}</b>，DNS 填任意公共 DNS（如 223.5.5.5），查询会被 TUN 劫持后交给内核解析。</span>
      </li>
      <li>
        <strong>确认生效</strong>
        <span>设备联网后会以它的局域网 IP 出现在「设备」页，类型为「局域网设备 · 网关」。</span>
      </li>
    </ol>
    <details class="gateway-manual">
      <summary>自动开启失败时，可以管理员身份在 PowerShell 手动运行</summary>
      <code>{{ forwardingCommand }}</code>
      <button type="button" class="secondary-button" @click="copyText(forwardingCommand)">{{ copied === forwardingCommand ? '已复制' : '复制命令' }}</button>
    </details>
  </section>
</template>

<style scoped>
.gateway-panel {
  display: grid;
  gap: var(--space-4);
  justify-items: start;
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
  font-size: var(--font-size-sm);
}
.gateway-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); justify-self: stretch; }
.gateway-head h2 { margin: 0 0 4px; font-size: var(--font-size-lg); }
.gateway-head p { margin: 0; max-width: 560px; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.gateway-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-3);
  padding: 5px 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-pill);
  background: var(--app-panel);
  color: var(--app-muted);
  font-size: var(--font-size-xs);
}
.gateway-status i { width: 7px; height: 7px; border-radius: 50%; background: #a6abb4; }
.gateway-status.active i { background: var(--app-green); }
.gateway-panel ol { display: grid; gap: var(--space-5); margin: 0; padding-left: 20px; justify-self: stretch; list-style: decimal; }
.gateway-panel li::marker { color: var(--app-muted); font-weight: 600; }
.gateway-panel li { display: grid; gap: var(--space-2); justify-items: start; }
.gateway-panel li span, .gateway-note { margin: 0; color: var(--app-muted); line-height: 1.55; }
.gateway-panel li b { color: var(--app-text); font-weight: 600; }
.gateway-panel code {
  display: block;
  justify-self: stretch;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  background: var(--app-fill);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
  user-select: text;
}
.gateway-error { color: var(--app-danger); font-size: var(--font-size-xs); }
.gateway-manual { display: grid; gap: var(--space-2); justify-items: start; justify-self: stretch; color: var(--app-muted); font-size: var(--font-size-xs); }
.gateway-manual summary { cursor: pointer; }
.gateway-manual[open] summary { margin-bottom: var(--space-2); }
</style>
