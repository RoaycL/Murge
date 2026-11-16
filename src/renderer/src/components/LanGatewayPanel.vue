<script setup lang="ts">
import { t } from '@shared/i18n'
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
  const names = (lan.gateway?.interfaces ?? []).map((entry) => t('common.quoted', [entry.name]))
  return names.length ? names.join(t('common.listSeparator')) : t('lanGateway.adapterPair', [lanAdapter.value, tunDevice.value])
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
  <section class="gateway-panel" :aria-label="t('lanGateway.title')">
    <header class="gateway-head">
      <div>
        <h2>{{ t('lanGateway.title') }}</h2>
        <p>{{ t('lanGateway.intro') }}</p>
      </div>
      <div class="gateway-status" :class="{ active: gatewayEnabled && tunActive && primaryLan }">
        <i />
        <span>{{ !gatewayEnabled ? t('common.notEnabled') : !tunActive ? t('lanGateway.needTun') : primaryLan ? t('lanGateway.gatewayAddress', [primaryLan]) : t('lanGateway.noLanAddress') }}</span>
      </div>
    </header>
    <ol>
      <li>
        <strong>{{ t('lanGateway.stepTun') }}</strong>
        <span>{{ tunActive ? t('lanGateway.tunOn') : t('lanGateway.tunOffHint') }}</span>
      </li>
      <li>
        <strong>{{ t('lanGateway.stepGateway') }}</strong>
        <span>{{ t('lanGateway.stepGatewayHint', [forwardingTargets, brand.shortName]) }}</span>
        <button type="button" class="secondary-button" :disabled="lan.gatewayBusy" @click="toggleGateway">{{ lan.gatewayBusy ? t('lanGateway.switching') : gatewayEnabled ? t('lanGateway.turnOffLabel') : t('lanGateway.turnOnLabel') }}</button>
        <span v-if="lan.gatewayError" class="gateway-error" role="alert">{{ lan.gatewayError }}</span>
      </li>
      <li>
        <strong>{{ t('lanGateway.stepDevice') }}</strong>
        <span>{{ t('lanGateway.stepDeviceA') }}<b>{{ t('lanGateway.routerGateway') }}</b>{{ t('lanGateway.stepDeviceB') }} <b>{{ primaryLan ?? t('lanGateway.thisLanIp') }}</b>{{ t('lanGateway.stepDeviceC') }}</span>
      </li>
      <li>
        <strong>{{ t('lanGateway.stepVerify') }}</strong>
        <span>{{ t('lanGateway.stepVerifyHint') }}</span>
      </li>
    </ol>
    <details class="gateway-manual">
      <summary>{{ t('lanGateway.manualHint') }}</summary>
      <code>{{ forwardingCommand }}</code>
      <button type="button" class="secondary-button" @click="copyText(forwardingCommand)">{{ copied === forwardingCommand ? t('common.copied') : t('lanGateway.copyCommand') }}</button>
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
