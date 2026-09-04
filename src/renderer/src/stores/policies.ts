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
  // 503 (probe failed / node unreachable) and "controller not reachable" are
  // both genuinely "no usable measurement" states. Every other failure — a
  // generic HTTP error, a missing group, an invalid payload — is NOT a node
  // availability verdict, so surface it as a generic error instead of a
  // misleading "unavailable".
  if (code === ProtocolErrorCode.UPSTREAM_TEST_FAILED || code === ProtocolErrorCode.UPSTREAM_UNREACHABLE) {
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

  // A request token only protects the UI: it cannot stop the controller from
  // applying an earlier PUT after a later one, so the UI would end up showing a
  // mode/member the controller did not actually reach. Instead we SERIALIZE each
  // mutation onto the controller (one in-flight write at a time) and coalesce
  // rapid intents into a single "latest-intent" slot, then CONFIRM the
  // controller's true state with a fresh read and reconcile the optimistic value
  // to it. An intent superseded by a newer one never mutates the UI or surfaces
  // an error.
  let pendingSelection: string | null = null
  let pendingMode: PolicyMode | null = null
  let selectionDrainPromise: Promise<void> | null = null
  let modeDrainPromise: Promise<void> | null = null
  // The most recent intent actually submitted, and the error it produced (if any).
  // Only the FINAL intent is used to reconcile against the controller read.
  let lastSelectionTarget: string | null = null
  let lastSelectionError: string | null = null
  let lastModeTarget: PolicyMode | null = null
  let lastModeError: string | null = null

  // mihomo 的 /proxies 响应按配置文件中 proxy-groups 的书写顺序序列化
  // （Go map 按插入序 marshal），zod 的 z.record 解析保留该顺序。这里只做
  // 类型过滤，绝不二次排序——所有者明确要求展示顺序与原始配置文件一致。
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

  function setMode(next: PolicyMode): Promise<void> {
    if (next === mode.value) return Promise.resolve()
    pendingMode = next
    modeDrainPromise ??= drainMode().finally(() => {
      modeDrainPromise = null
      pendingMode = null
    })
    return modeDrainPromise
  }

  async function drainMode(): Promise<void> {
    try {
      while (pendingMode !== null) {
        const intent = pendingMode
        pendingMode = null
        lastModeTarget = intent
        lastModeError = null
        if (intent === mode.value) continue
        mode.value = intent
        panelError.value = null
        try {
          await window.desktop.mihomo.patchConfig({ mode: intent })
        } catch (error) {
          // A newer intent arrived while this write was in flight, so its outcome
          // no longer matters; only the FINAL intent's failure is surfaced.
          if (pendingMode === null) lastModeError = toProtocolError(error).message
        }
      }
      await confirmMode()
    } finally {
      lastModeTarget = null
      lastModeError = null
    }
  }

  async function confirmMode(): Promise<void> {
    const target = lastModeTarget
    const submitError = lastModeError
    try {
      const config = await window.desktop.mihomo.getConfig()
      const confirmed = config.mode && POLICY_MODE_OPTIONS.includes(config.mode) ? (config.mode as PolicyMode) : null
      if (confirmed) mode.value = confirmed
      if (submitError) {
        panelError.value = submitError
      } else if (target !== null && confirmed !== null && confirmed !== target) {
        panelError.value = `模式切换未生效：controller 当前为 "${confirmed}"，期望 "${target}"`
      }
    } catch (error) {
      panelError.value = submitError ?? toProtocolError(error).message
    }
  }

  function selectNode(member: string): Promise<void> {
    const group = selectedGroup.value
    if (!group) return Promise.resolve()
    if (member === selectedMember.value) return Promise.resolve()
    pendingSelection = member
    selectionDrainPromise ??= drainSelection(group).finally(() => {
      selectionDrainPromise = null
      pendingSelection = null
    })
    return selectionDrainPromise
  }

  async function drainSelection(group: string): Promise<void> {
    try {
      while (pendingSelection !== null) {
        if (selectedGroup.value !== group) return
        const intent = pendingSelection
        pendingSelection = null
        lastSelectionTarget = intent
        lastSelectionError = null
        if (intent === selectedMember.value) continue
        selectedMember.value = intent
        panelError.value = null
        try {
          await window.desktop.mihomo.selectProxy(group, intent)
        } catch (error) {
          if (pendingSelection === null) lastSelectionError = toProtocolError(error).message
        }
      }
      if (selectedGroup.value === group) await confirmSelection(group)
    } finally {
      lastSelectionTarget = null
      lastSelectionError = null
    }
  }

  async function confirmSelection(group: string): Promise<void> {
    const target = lastSelectionTarget
    const submitError = lastSelectionError
    try {
      const result = await window.desktop.mihomo.getProxies()
      const now = result.proxies[group]?.now
      const confirmed = typeof now === 'string' && now.length > 0 ? now : null
      if (confirmed) selectedMember.value = confirmed
      if (submitError) {
        panelError.value = submitError
      } else if (target !== null && confirmed !== null && confirmed !== target) {
        panelError.value = `选择未生效：controller 当前为 "${confirmed}"，期望 "${target}"`
      }
    } catch (error) {
      panelError.value = submitError ?? toProtocolError(error).message
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
      // Upstream's group delay endpoint writes a member into the map ONLY when
      // its probe succeeded (err == nil); a node that timed out, was unreachable,
      // or simply wasn't measured is OMITTED. So an absent key is not evidence of
      // a timeout — label it "unavailable" (no usable measurement) rather than
      // "timeout", which would mislabel reachable nodes that merely went untested.
      // The whole-group 504 "all proxies timeout" case still surfaces through the
      // catch branch below as UPSTREAM_TIMEOUT -> 'timeout' for every member.
      for (const member of members) {
        const delay = map[member]
        if (typeof delay === 'number' && delay >= 0) setDelay(member, { status: 'ok', delay })
        else setDelay(member, { status: 'unavailable', delay: null })
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
