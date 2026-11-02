<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLanStore } from '../stores/lan'
import { useTunStore } from '../stores/tun'
import { useTunConfigStore } from '../stores/tun-config'
import { lanAddresses } from '@shared/lan'
import { brand } from '@shared/brand'

/**
 * 网关模式 setup guide. mihomo has no DHCP server, so Murge cannot hand out
 * leases the way Surge does. With TUN on and Windows IP forwarding enabled, a
 * device whose gateway is set to this PC by hand is routed into the TUN
 * adapter, where mihomo takes over its traffic (DNS included, via
 * dns-hijack). Forwarding needs an elevated shell, so the guide hands the
 * user the exact command instead of changing the host on its own.
 */
const lan = useLanStore()
const tun = useTunStore()
const tunConfig = useTunConfigStore()
onMounted(() => {
  void lan.refresh()
  void tunConfig.refresh()
})

const tunActive = computed(() => tun.status.phase === 'active')
const lanHosts = computed(() => lanAddresses(lan.addresses))
const primaryLan = computed(() => lanHosts.value[0]?.address ?? null)
const tunDevice = computed(() => tunConfig.config.device === 'Mihomo' ? `${brand.shortName} TUN` : tunConfig.config.device)
const lanAdapter = computed(() => lanHosts.value[0]?.name ?? 'WLAN')
const forwardingCommand = computed(() => `Set-NetIPInterface -InterfaceAlias "${lanAdapter.value}", "${tunDevice.value}" -AddressFamily IPv4 -Forwarding Enabled`)
const forwardingUndo = computed(() => forwardingCommand.value.replace(/Enabled$/, 'Disabled'))

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
        <p>让局域网内的手机、电视、游戏机等设备把网关指向本机，由 TUN 接管它们的全部流量。mihomo 不提供 DHCP 服务，需要在设备上手动设置网关。</p>
      </div>
      <div class="gateway-status" :class="{ active: tunActive && primaryLan }">
        <i />
        <span>{{ !tunActive ? '需先开启 TUN 模式' : primaryLan ? `网关地址 ${primaryLan}` : '未检测到局域网地址' }}</span>
      </div>
    </header>
    <ol>
      <li>
        <strong>开启 TUN 模式</strong>
        <span>{{ tunActive ? '已开启。' : '在概览打开「TUN 模式」开关。' }}</span>
      </li>
      <li>
        <strong>开启 Windows 转发</strong>
        <span>以管理员身份打开 PowerShell 运行下面的命令，让本机转发其他设备的数据包。TUN 网卡重建后如果失效，重新运行一次即可。</span>
        <code>{{ forwardingCommand }}</code>
        <button type="button" class="secondary-button" @click="copyText(forwardingCommand)">{{ copied === forwardingCommand ? '已复制' : '复制命令' }}</button>
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
    <p class="gateway-note">连不上时，请确认当前网络在 Windows 中是「专用网络」，并在 Windows 防火墙中允许 mihomo 入站。不再需要时可运行下面的命令关闭转发：</p>
    <code>{{ forwardingUndo }}</code>
    <button type="button" class="secondary-button" @click="copyText(forwardingUndo)">{{ copied === forwardingUndo ? '已复制' : '复制命令' }}</button>
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
</style>
