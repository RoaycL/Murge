import { ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * INTERNET-latency card state. One explicit sample at a time: numbers are only
 * ever shown when the main process actually measured them; `null` renders as
 * an em dash and a failed slot never poisons the others.
 */
export type LatencyState = 'idle' | 'probing' | 'ready' | 'error'

export const useLatencyStore = defineStore('latency', () => {
  const state = ref<LatencyState>('idle')
  const gatewayMs = ref<number | null>(null)
  const dnsMs = ref<number | null>(null)
  const proxyMs = ref<number | null>(null)
  const proxyNode = ref<string | null>(null)
  let probeSeq = 0

  async function probe(): Promise<void> {
    const seq = ++probeSeq
    state.value = 'probing'
    try {
      const result = await window.desktop.mihomo.internetLatency()
      if (seq !== probeSeq) return // a newer probe superseded this one
      gatewayMs.value = result.gatewayMs
      dnsMs.value = result.dnsMs
      proxyMs.value = result.proxyMs
      proxyNode.value = result.proxyNode
      state.value = 'ready'
    } catch {
      if (seq !== probeSeq) return
      state.value = 'error'
    }
  }

  /** Auto-probe once when the card first mounts; the button re-probes after. */
  function init(): void {
    if (state.value === 'idle') void probe()
  }

  return { state, gatewayMs, dnsMs, proxyMs, proxyNode, probe, init }
})
