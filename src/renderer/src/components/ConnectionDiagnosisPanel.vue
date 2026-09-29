<script setup lang="ts">
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
  else error.value = '网络探测未完成，请检查内核状态后重试。'
  if (results[1]?.status === 'fulfilled') directMs.value = results[1].value.delay
  if (results[2]?.status === 'fulfilled') tun.value = results[2].value as TunStatus
  if (results[3]?.status === 'fulfilled') systemProxy.value = results[3].value as SystemProxyStatus
  if (results.length === 6) {
    dns.value = (['A', 'AAAA'] as const).map((type, index) => {
      const outcome = results[index + 4]
      return { type, result: outcome?.status === 'fulfilled' ? outcome.value as MihomoDnsQueryResult : null, error: outcome?.status === 'rejected' ? '查询失败' : '' }
    })
  }
  running.value = false
}
</script>

<template>
  <section class="connection-diagnosis" aria-label="连接路径诊断">
    <h3>为什么走这条线路</h3>
    <p>以下是这条连接建立时由内核记录的路径；切换节点不会改写已有连接。</p>
    <ol>
      <li><span>目标</span><strong>{{ connection.metadata.host || connection.metadata.destinationIP || '未知目标' }}</strong></li>
      <li><span>命中规则</span><strong>{{ connection.rule || '未知' }} {{ connection.rulePayload }}</strong></li>
      <li><span>实际策略链</span><strong>{{ route().length ? route().join(' → ') : 'DIRECT' }}</strong></li>
    </ol>
    <button type="button" :disabled="running" @click="inspect">{{ running ? '检查中…' : '检查当前网络' }}</button>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <div v-if="latency || directMs !== null" class="connection-diagnosis-result" role="status">
      <span>默认网关 {{ latency?.gatewayMs == null ? '未测得' : `${latency.gatewayMs} ms` }}</span>
      <span>DNS {{ latency?.dnsMs == null ? '未测得' : `${latency.dnsMs} ms` }}</span>
      <span>内核 DIRECT 出站 {{ directMs === null ? '未测得' : `${directMs} ms` }}</span>
      <span>当前默认策略节点 {{ latency?.proxyNode ?? '无' }} · {{ latency?.proxyMs == null ? '未测得' : `${latency.proxyMs} ms` }}</span>
    </div>
    <div v-if="tun || systemProxy" class="connection-diagnosis-result">
      <span>TUN：{{ tun ? (tun.phase === 'active' ? '已启用' : '未启用或未就绪') : '状态未知' }}</span>
      <span>系统代理：{{ systemProxy ? (systemProxy.phase === 'enabled' ? '已启用' : '未启用或未就绪') : '状态未知' }}</span>
    </div>
    <div v-for="entry in dns" :key="entry.type" class="connection-diagnosis-result">
      <span>{{ entry.type }}：{{ entry.error || entry.result?.Answer?.map((record) => record.data).join('、') || '无回答' }}</span>
    </div>
    <p v-if="latency || tun || systemProxy">网络探测是当前时刻的参考值；默认策略节点的延迟不一定是这条连接所用节点。网关只代表第一跳；DIRECT 是内核的直连出站探测，启用 TUN 时仍可能经过系统虚拟网卡，不能单凭这些数值归因运营商或证明单条连接的实际出口。</p>
  </section>
</template>

<style scoped>
.connection-diagnosis{display:grid;gap:10px;margin-top:20px;padding:15px;border:1px solid var(--app-divider);border-radius:12px}
.connection-diagnosis h3,.connection-diagnosis p{margin:0}
.connection-diagnosis p{color:var(--app-muted);font-size:11px;line-height:1.5}
.connection-diagnosis ol{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.connection-diagnosis li{display:grid;gap:3px;font-size:11px}
.connection-diagnosis li span{color:var(--app-muted)}
.connection-diagnosis li strong{overflow-wrap:anywhere;font-size:12px;font-weight:500}
.connection-diagnosis button{justify-self:start;padding:7px 11px;border:0;border-radius:8px;background:var(--app-accent);color:white;cursor:pointer}
.connection-diagnosis button:disabled{opacity:.5;cursor:not-allowed}
.connection-diagnosis-result{display:grid;gap:4px;overflow-wrap:anywhere;font-size:11px}
</style>
