import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { MihomoDnsQueryResult, MihomoDnsQueryType } from '@shared/mihomo-api'

export const useDnsStore = defineStore('dns', () => {
  const name = ref('example.com')
  const type = ref<MihomoDnsQueryType>('A')
  const result = ref<MihomoDnsQueryResult | null>(null)
  const busy = ref(false)
  const message = ref<string | null>(null)
  const error = ref<string | null>(null)

  async function query(): Promise<void> {
    busy.value = true; message.value = null; error.value = null
    try { result.value = await window.desktop.mihomo.dnsQuery(name.value, type.value) }
    catch (cause) { result.value = null; error.value = cause instanceof Error ? cause.message : String(cause) }
    finally { busy.value = false }
  }

  async function flush(kind: 'dns' | 'fakeip'): Promise<void> {
    busy.value = true; message.value = null; error.value = null
    try {
      if (kind === 'dns') await window.desktop.mihomo.flushDnsCache()
      else await window.desktop.mihomo.flushFakeIpCache()
      message.value = kind === 'dns' ? 'DNS 缓存已清除' : 'Fake-IP 缓存已清除'
    } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
    finally { busy.value = false }
  }

  return { name, type, result, busy, message, error, query, flush }
})
