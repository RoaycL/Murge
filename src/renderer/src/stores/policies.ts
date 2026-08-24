import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MihomoProxiesResponse, MihomoProxy } from '@shared/mihomo-api'
import { ProtocolErrorCode, toProtocolError } from '@shared/protocol-errors'

export type PolicyStatus = 'idle' | 'loading' | 'ready' | 'error'
export type DelayStatus = 'idle' | 'testing' | 'ok' | 'timeout' | 'unavailable' | 'error'

export interface DelayNodeState {
  status: DelayStatus
  delay: number | null
}

export type PolicyGroupType = 'Selector' | 'URLTest' | 'Fallback' | 'LoadBalance' | 'Relay'
export const POLICY_GROUP_TYPES: readonly PolicyGroupType[] = ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay']
export const POLICY_MODE_OPTIONS = ['rule', 'global', 'direct'] as const
export type PolicyMode = (typeof POLICY_MODE_OPTIONS)[number]

/** Map a thrown value onto the visible delay state. */
function classifyDelayError(value: unknown): DelayStatus {
  const code = toProtocolError(value).code
  if (code === ProtocolErrorCode.UPSTREAM_TIMEOUT) return 'timeout'
  if (code === ProtocolErrorCode.UPSTREAM_HTTP_ERROR || code === ProtocolErrorCode.UPSTREAM_UNREACHABLE || code === ProtocolErrorCode.NOT_FOUND) {
    return 'unavailable'
  }
  return 'error'
}

export const usePoliciesStore = defineStore('policies', () => {
  const status = ref<PolicyStatus>('idle')
  const lastError = ref<string | null>(null)
  const proxies = ref<MihomoProxiesResponse | null>(null)
  const selectedGroup = ref<string>('')
  const selectedMember = ref<string>('')
  const mode = ref<PolicyMode>('rule')
  const delayByNode = ref<Record<string, DelayNodeState>>({})
  const groupDelayStatus = ref<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const panelError = ref<string | null>(null)

  // Monotonic request tokens: only the LATEST mode/selection request may mutate
  // or roll back state. A stale request that resolves (or fails) after a newer
  // one must not clobber the user's most recent intent.
  let modeRequestId = 0
  let selectionRequestId = 0

  const groups = computed<MihomoProxy[]>(() => {
    if (!proxies.value) return []
    return Object.values(proxies.value.proxies).filter((proxy) => POLICY_GROUP_TYPES.includes(proxy.type as PolicyGroupType))
  })

  const groupMembers = computed<string[]>(() => {
    const group = currentGroup.value
    if (!group) return []
    return group.all ?? []
  })

  const currentGroup = computed<MihomoProxy | null>(() => {
    if (!proxies.value || !selectedGroup.value) return null
    return proxies.value.proxies[selectedGroup.value] ?? null
  })

  const nodeByMember = computed<Record<string, MihomoProxy | null>>(() => {
    const out: Record<string, MihomoProxy | null> = {}
    if (!proxies.value) return out
    for (const member of groupMembers.value) {
      out[member] = proxies.value.proxies[member] ?? null
    }
    return out
  })

  function nodeState(name: string): DelayNodeState {
    return delayByNode.value[name] ?? { status: 'idle', delay: null }
  }

  function setDelay(name: string, state: DelayNodeState): void {
    delayByNode.value = { ...delayByNode.value, [name]: state }
  }

  async function load(): Promise<void> {
    status.value = 'loading'
    lastError.value = null
    try {
      const result = await window.desktop.mihomo.getProxies()
      proxies.value = result
      const firstGroup = Object.values(result.proxies).find((proxy) => POLICY_GROUP_TYPES.includes(proxy.type as PolicyGroupType))
      if (firstGroup) {
        selectedGroup.value = firstGroup.name
        selectedMember.value = typeof firstGroup.now === 'string' ? firstGroup.now : (firstGroup.all?.[0] ?? '')
      }
      status.value = 'ready'
    } catch (error) {
      lastError.value = toProtocolError(error).message
      status.value = 'error'
    }
  }

  function selectGroup(name: string): void {
    if (!proxies.value) return
    const group = proxies.value.proxies[name]
    if (!group || !POLICY_GROUP_TYPES.includes(group.type as PolicyGroupType)) return
    selectedGroup.value = name
    selectedMember.value = typeof group.now === 'string' ? group.now : (group.all?.[0] ?? '')
  }

  async function setMode(next: PolicyMode): Promise<void> {
    if (next === mode.value) return
    const seq = ++modeRequestId
    const previous = mode.value
    mode.value = next
    panelError.value = null
    try {
      await window.desktop.mihomo.patchConfig({ mode: next })
    } catch (error) {
      if (seq === modeRequestId) {
        mode.value = previous
        panelError.value = toProtocolError(error).message
      }
    }
  }

  async function selectNode(member: string): Promise<void> {
    if (!selectedGroup.value || member === selectedMember.value) return
    const seq = ++selectionRequestId
    const previous = selectedMember.value
    selectedMember.value = member
    panelError.value = null
    try {
      await window.desktop.mihomo.selectProxy(selectedGroup.value, member)
    } catch (error) {
      if (seq === selectionRequestId) {
        selectedMember.value = previous
        panelError.value = toProtocolError(error).message
      }
      throw error
    }
  }

  async function testNode(name: string): Promise<void> {
    setDelay(name, { status: 'testing', delay: null })
    try {
      const result = await window.desktop.mihomo.delayTest(name)
      setDelay(name, { status: 'ok', delay: result.delay })
    } catch (error) {
      setDelay(name, { status: classifyDelayError(error), delay: null })
    }
  }

  async function testAll(): Promise<void> {
    if (!selectedGroup.value) return
    groupDelayStatus.value = 'testing'
    const members = groupMembers.value
    try {
      const map = await window.desktop.mihomo.groupDelayTest(selectedGroup.value)
      for (const member of members) {
        const delay = map[member]
        if (typeof delay === 'number' && delay >= 0) setDelay(member, { status: 'ok', delay })
        else setDelay(member, { status: 'timeout', delay: null })
      }
      groupDelayStatus.value = 'ok'
    } catch (error) {
      groupDelayStatus.value = 'error'
      panelError.value = toProtocolError(error).message
      for (const member of members) setDelay(member, { status: classifyDelayError(error), delay: null })
    }
  }

  function reset(): void {
    status.value = 'idle'
    lastError.value = null
    proxies.value = null
    selectedGroup.value = ''
    selectedMember.value = ''
    delayByNode.value = {}
    groupDelayStatus.value = 'idle'
    panelError.value = null
  }

  return {
    status,
    lastError,
    panelError,
    proxies,
    selectedGroup,
    selectedMember,
    mode,
    delayByNode,
    groupDelayStatus,
    groups,
    groupMembers,
    currentGroup,
    nodeByMember,
    nodeState,
    load,
    selectGroup,
    setMode,
    selectNode,
    testNode,
    testAll,
    reset
  }
})
