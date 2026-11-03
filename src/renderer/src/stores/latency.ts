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

  /**
   * Right after the kernel comes up, proxy groups and node DNS can still be
   * warming, so the first sample may come back without a proxy number. Retry
   * once after a short pause instead of leaving "—" for a whole minute.
   */
  async function probeAfterKernelStart(retryDelayMs = 3000): Promise<void> {
    await probe()
    if (proxyMs.value != null) return
    const seq = probeSeq
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    if (seq === probeSeq) await probe() // skip if something newer already probed
  }

  /** Auto-probe once when the card first mounts; the button re-probes after. */
  function init(): void {
    if (state.value === 'idle') void probe()
  }

  return { state, gatewayMs, dnsMs, proxyMs, proxyNode, probe, probeAfterKernelStart, init }
})
