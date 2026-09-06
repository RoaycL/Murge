import { defineStore } from 'pinia'
import { ref } from 'vue'
import { UNLOCK_SERVICES } from '@shared/unlock'
import type { ServiceUnlockResult } from '@shared/unlock'

/**
 * 解锁测试 state for the 网络诊断 drawer (参考 clash-verge-rev): per-service
 * verdicts filled incrementally — `testAll` keeps every finished probe in
 * sync as it lands, `testOne` re-runs a single row. No persistence: verdicts
 * are ephemeral egress facts tied to the currently selected node.
 */
export const useUnlockStore = defineStore('unlock', () => {
  const results = ref<Record<string, ServiceUnlockResult>>({})
  const testing = ref<Record<string, boolean>>({})
  const testingAll = ref(false)
  const error = ref<string | null>(null)

  function orderedResults(): ServiceUnlockResult[] {
    return UNLOCK_SERVICES.map(
      (name) =>
        results.value[name] ?? { name, status: 'error' as const, region: null }
    )
  }

  async function testAll(): Promise<void> {
    if (testingAll.value) return
    testingAll.value = true
    error.value = null
    // Verdicts describe one point-in-time egress. Clear the previous node's
    // rows before probing so a failed refresh can never leave stale results.
    results.value = {}
    for (const name of UNLOCK_SERVICES) testing.value[name] = true
    try {
      const verdicts = await window.desktop.unlock.testAll()
      for (const verdict of verdicts) results.value[verdict.name] = verdict
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      for (const name of UNLOCK_SERVICES) testing.value[name] = false
      testingAll.value = false
    }
  }

  function reset(): void {
    results.value = {}
    testing.value = {}
    error.value = null
  }

  async function testOne(name: string): Promise<void> {
    if (testing.value[name]) return
    testing.value[name] = true
    error.value = null
    try {
      results.value[name] = await window.desktop.unlock.testOne(name)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      testing.value[name] = false
    }
  }

  return { results, testing, testingAll, error, orderedResults, testAll, testOne, reset }
})
