<script setup lang="ts">
import { t } from '@shared/i18n'
import { ref, watch } from 'vue'
import type { MihomoConnection, MihomoDnsQueryResult } from '@shared/mihomo-api'
import { connectionChainHops } from '@shared/connection-chain'

const props = defineProps<{ connection: MihomoConnection }>()
type Latency = Awaited<ReturnType<typeof window.desktop.mihomo.internetLatency>>
type TunStatus = Awaited<ReturnType<typeof window.desktop.tun.getStatus>>
type SystemProxyStatus = Awaited<ReturnType<typeof window.desktop.systemProxy.getStatus>>
const running = ref(false)
const error = ref('')
const latency = ref<Latency | null>(null)
const directMs = ref<number | null>(null)
const tun = ref<TunStatus | null>(null)
const systemProxy = ref<SystemProxyStatus | null>(null)
const dns = ref<Array<{ type: 'A' | 'AAAA'; result: MihomoDnsQueryResult | null; error: string }>>([])
const host = () => props.connection.metadata.host?.trim() ?? ''
const route = () => connectionChainHops(props.connection.chains)
let generation = 0

watch(() => props.connection.id, () => {
  generation += 1; running.value = false; error.value = ''; latency.value = null; directMs.value = null; tun.value = null; systemProxy.value = null; dns.value = []
})

async function inspect(): Promise<void> {
  const current = ++generation
  const target = host()
  running.value = true; error.value = ''; latency.value = null; directMs.value = null; tun.value = null; systemProxy.value = null; dns.value = []
  const results = await Promise.allSettled([
    window.desktop.mihomo.internetLatency(),
    window.desktop.mihomo.delayTest('DIRECT', { timeout: 5000 }),
    window.desktop.tun.getStatus(),
    window.desktop.systemProxy.getStatus(),
    ...(target && !/[\s/:]/.test(target) ? [window.desktop.mihomo.dnsQuery(target, 'A'), window.desktop.mihomo.dnsQuery(target, 'AAAA')] : [])
  ])
  if (current !== generation) return
  const first = results[0]
  if (first?.status === 'fulfilled') latency.value = first.value as Latency
  else error.value = t('diagnosis.probeIncomplete')
  if (results[1]?.status === 'fulfilled') directMs.value = results[1].value.delay
  if (results[2]?.status === 'fulfilled') tun.value = results[2].value as TunStatus
  if (results[3]?.status === 'fulfilled') systemProxy.value = results[3].value as SystemProxyStatus
  if (results.length === 6) {
    dns.value = (['A', 'AAAA'] as const).map((type, index) => {
      const outcome = results[index + 4]
      return { type, result: outcome?.status === 'fulfilled' ? outcome.value as MihomoDnsQueryResult : null, error: outcome?.status === 'rejected' ? t('diagnosis.queryFailed') : '' }
    })
  }
  running.value = false
}
</script>

<template>
  <section class="connection-diagnosis" :aria-label="t('diagnosis.label')">
    <h3>{{ t('diagnosis.title') }}</h3>
    <p>{{ t('diagnosis.intro') }}</p>
    <ol>
      <li><span>{{ t('diagnosis.target') }}</span><strong>{{ connection.metadata.host || connection.metadata.destinationIP || t('diagnosis.unknownTarget') }}</strong></li>
      <li><span>{{ t('diagnosis.matchedRule') }}</span><strong>{{ connection.rule || t('common.unknown') }} {{ connection.rulePayload }}</strong></li>
      <li><span>{{ t('diagnosis.policyChain') }}</span><strong>{{ route().length ? route().join(' → ') : 'DIRECT' }}</strong></li>
    </ol>
    <button type="button" :disabled="running" @click="inspect">{{ running ? t('diagnosis.checking') : t('diagnosis.checkNetwork') }}</button>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <div v-if="latency || directMs !== null" class="connection-diagnosis-result" role="status">
      <span>{{ t('diagnosis.gateway', [latency?.gatewayMs == null ? t('diagnosis.notMeasured') : `${latency.gatewayMs} ms`]) }}</span>
      <span>DNS {{ latency?.dnsMs == null ? t('diagnosis.notMeasured') : `${latency.dnsMs} ms` }}</span>
      <span>{{ t('diagnosis.direct', [directMs === null ? t('diagnosis.notMeasured') : `${directMs} ms`]) }}</span>
      <span>{{ t('diagnosis.defaultNode', [latency?.proxyNode ?? t('common.none'), latency?.proxyMs == null ? t('diagnosis.notMeasured') : `${latency.proxyMs} ms`]) }}</span>
    </div>
    <div v-if="tun || systemProxy" class="connection-diagnosis-result">
      <span>{{ t('common.labelValue', ['TUN', tun ? (tun.phase === 'active' ? t('common.enabled') : t('diagnosis.notEnabledOrReady')) : t('diagnosis.statusUnknown')]) }}</span>
      <span>{{ t('diagnosis.systemProxy', [systemProxy ? (systemProxy.phase === 'enabled' ? t('common.enabled') : t('diagnosis.notEnabledOrReady')) : t('diagnosis.statusUnknown')]) }}</span>
    </div>
    <div v-for="entry in dns" :key="entry.type" class="connection-diagnosis-result">
      <span>{{ t('common.labelValue', [entry.type, entry.error || entry.result?.Answer?.map((record) => record.data).join(t('common.listSeparator')) || t('diagnosis.noAnswer')]) }}</span>
    </div>
    <p v-if="latency || tun || systemProxy">{{ t('diagnosis.disclaimer') }}</p>
  </section>
</template>

<style scoped>
.connection-diagnosis{display:grid;gap:var(--space-4);margin-top:20px;padding:15px;border:1px solid var(--app-divider);border-radius:var(--radius-card)}
.connection-diagnosis h3,.connection-diagnosis p{margin:0}
.connection-diagnosis p{color:var(--app-muted);font-size:var(--font-size-xs);line-height:1.5}
.connection-diagnosis ol{display:grid;gap:var(--space-3);margin:0;padding:0;list-style:none}
.connection-diagnosis li{display:grid;gap:var(--space-1);font-size:var(--font-size-xs)}
.connection-diagnosis li span{color:var(--app-muted)}
.connection-diagnosis li strong{overflow-wrap:anywhere;font-size:var(--font-size-sm);font-weight:var(--font-weight-medium)}
.connection-diagnosis button{justify-self:start;padding:7px 11px;border:0;border-radius:var(--radius-control);background:var(--app-accent);color:var(--app-on-accent);cursor:pointer}
.connection-diagnosis button:disabled{opacity:.5;cursor:not-allowed}
.connection-diagnosis-result{display:grid;gap:var(--space-1);overflow-wrap:anywhere;font-size:var(--font-size-xs)}
</style>
