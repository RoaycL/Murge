import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MihomoProxiesResponse, MihomoProxy } from '@shared/mihomo-api'
import { ProtocolErrorCode, toProtocolError } from '@shared/protocol-errors'

export type PolicyStatus = 'idle' | 'loading' | 'ready' | 'error'
export type DelayStatus = 'idle' | 'testing' | 'ok' | 'timeout' | 'unavailable' | 'error'

export interface DelayNodeState {
  status: DelayStatus
  delay: number | null
  url?: string
  error?: string
}

export type PolicyGroupType = 'Selector' | 'URLTest' | 'Fallback' | 'LoadBalance'
export const SELECTABLE_POLICY_GROUP_TYPES = ['Selector', 'URLTest', 'Fallback'] as const
export const POLICY_MODE_OPTIONS = ['rule', 'global', 'direct'] as const
export type PolicyMode = (typeof POLICY_MODE_OPTIONS)[number]

function isPolicyGroup(proxy: MihomoProxy | undefined): proxy is MihomoProxy {
  return Boolean(proxy && Array.isArray(proxy.all))
}

function isSelectableGroup(proxy: MihomoProxy | null | undefined): boolean {
  return Boolean(proxy && SELECTABLE_POLICY_GROUP_TYPES.includes(proxy.type as (typeof SELECTABLE_POLICY_GROUP_TYPES)[number]))
}

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
  const delayGeneration = new Map<string, number>()
  const groupDelayGeneration = new Map<string, number>()

  // Policy groups render in the ACTIVE PROFILE DOCUMENT's proxy-groups order.
  // Neither controller endpoint can supply this: `GET /proxies` is a Go map
  // (JSON-marshaled with sorted keys) and `GET /group` iterates that same map
  // (Go range order — randomized per request; verified against a real kernel).
  // The main process parses the active profile YAML it already owns, so the
  // order below is the config file's own. Ordered names are merged back into
  // the /proxies payload for full proxy detail; when the profile or the fetch
  // is unavailable we fall back to the (unsorted but harmless) map order.
  const orderedGroupNames = ref<string[]>([])
  const groups = computed<MihomoProxy[]>(() => {
    if (!proxies.value) return []
    const byName = proxies.value.proxies
    if (orderedGroupNames.value.length > 0) {
      const merged: MihomoProxy[] = []
      for (const name of orderedGroupNames.value) {
        const proxy = byName[name]
        if (isPolicyGroup(proxy)) merged.push(proxy)
      }
      return merged
    }
    return Object.values(byName).filter((proxy) => isPolicyGroup(proxy))
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

  function delayKey(group: string, name: string): string {
    return `${group}\u0000${name}`
  }

  function nodeState(name: string): DelayNodeState {
    return delayByNode.value[delayKey(selectedGroup.value, name)] ?? { status: 'idle', delay: null }
  }

  function setDelay(group: string, name: string, state: DelayNodeState): void {
    delayByNode.value = { ...delayByNode.value, [delayKey(group, name)]: state }
  }

  /**
   * The member a group should APPEAR to have selected. For Selector groups the
   * controller's `now` IS the selection, but URLTest/Fallback groups report two
   * fields: `now` (the currently-dialed fastest ALIVE member) and `fixed` (the
   * node the user pinned via PUT). The kernel honors the pin only while that
   * node is alive for the group's test URL, so `now` can legitimately differ
   * from the user's choice; the UI must surface the user's choice.
   */
  function groupSelectedMember(group: MihomoProxy): string {
    if (typeof group.fixed === 'string' && group.fixed.length > 0) return group.fixed
    if (typeof group.now === 'string' && group.now.length > 0) return group.now
    return isSelectableGroup(group) ? (group.all?.[0] ?? '') : ''
  }

  async function load(): Promise<void> {
    status.value = 'loading'
    lastError.value = null
    // A profile/settings reload can change the effective probe URL. Never show
    // a result measured under the previous profile as if it belonged to this one.
    delayByNode.value = {}
    delayGeneration.clear()
    groupDelayGeneration.clear()
    try {
      // Fetch BOTH sources up front: the config-file group order (active
      // profile document, parsed in main) and the full detail map (/proxies).
      const [orderResult, result] = await Promise.all([
        window.desktop.profiles.getActiveGroupOrder().catch(() => [] as string[]),
        window.desktop.mihomo.getProxies()
      ])
      orderedGroupNames.value = orderResult.filter((name) => {
        const proxy = result.proxies[name]
        return isPolicyGroup(proxy)
      })
      proxies.value = result
      const ordered = groups.value
      const firstGroup = ordered.length > 0 ? ordered[0] : null
      if (firstGroup) {
        selectedGroup.value = firstGroup.name
        selectedMember.value = groupSelectedMember(firstGroup)
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
    if (!isPolicyGroup(group)) return
    selectedGroup.value = name
    selectedMember.value = groupSelectedMember(group)
    // The aggregate state belongs to the previously open group. Per-member
    // results remain keyed by group and can be reused, but the new group must
    // never inherit a stale "testing" or "failed" banner.
    groupDelayStatus.value = 'idle'
    panelError.value = null
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
    if (!isSelectableGroup(currentGroup.value)) {
      panelError.value = `${currentGroup.value?.type ?? '当前'} 策略组由内核自动选择，不支持手动固定节点`
      return Promise.resolve()
    }
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
      const groupProxy = result.proxies[group]
      // URLTest/Fallback groups report the user's pin in `fixed` while `now`
      // keeps pointing at the fastest ALIVE member (the kernel dials the pin
      // only while it stays alive for the group's test URL). Confirm against
      // `fixed` when the controller reports one, so a legitimately slower or
      // cold-but-alive pick is not reported as a failed selection; Selector
      // groups expose no `fixed`, so they confirm against `now` as before.
      const pinned = groupProxy ? groupSelectedMember(groupProxy) : null
      const confirmed = pinned && pinned.length > 0 ? pinned : null
      if (confirmed) selectedMember.value = confirmed
      // Adopt the controller's fresh snapshot wholesale so group cards (`now`,
      // `fixed`, `alive`) reflect the write immediately instead of waiting for
      // the next poll.
      proxies.value = result
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
    const group = selectedGroup.value
    if (!group) return
    // A direct item probe supersedes any older whole-group sweep for this view.
    groupDelayGeneration.set(group, (groupDelayGeneration.get(group) ?? 0) + 1)
    groupDelayStatus.value = 'idle'
    await testGroupMember(group, name)
  }

  /** Run one group-aware probe and discard a stale result from an older run. */
  async function testGroupMember(group: string, name: string): Promise<boolean> {
    const key = delayKey(group, name)
    const generation = (delayGeneration.get(key) ?? 0) + 1
    delayGeneration.set(key, generation)
    setDelay(group, name, { status: 'testing', delay: null })
    try {
      const result = await window.desktop.mihomo.groupMemberDelayTest(group, name, { timeout: 10000 })
      if (delayGeneration.get(key) !== generation) return false
      if (!(Number.isFinite(result.delay) && result.delay > 0)) {
        setDelay(group, name, { status: 'unavailable', delay: null })
        return false
      }
      setDelay(group, name, { status: 'ok', delay: result.delay, url: result.url })
      return true
    } catch (error) {
      if (delayGeneration.get(key) === generation) {
        const protocolError = toProtocolError(error)
        setDelay(group, name, {
          status: classifyDelayError(protocolError),
          delay: null,
          error: protocolError.message
        })
      }
      return false
    }
  }

  /**
   * Probe every member of the open group. mihomo-party abandoned the kernel's
   * `/group/:name/delay` endpoint for this and so do we, for three reasons:
   * 1. it runs all probes inside ONE context — a single timeout budget shared
   *    by the whole group, so a batch of cold TLS handshakes tips the entire
   *    request into 504 "all proxies timeout" even on a healthy tunnel;
   * 2. it FORCE-CLEARS a URLTest/Fallback group's pinned selection, so the
   *    node the user picked is silently reverted on every group test;
   * 3. results only arrive once the whole batch settles, with no per-node
   *    feedback.
   * Per-node probes (party/sparkle style) each get their own full timeout,
   * leave the pin untouched, and can update the UI as each result lands.
   */
  async function testAll(): Promise<void> {
    if (!selectedGroup.value) return
    const group = selectedGroup.value
    const members = [...groupMembers.value]
    const batchGeneration = (groupDelayGeneration.get(group) ?? 0) + 1
    groupDelayGeneration.set(group, batchGeneration)
    groupDelayStatus.value = 'testing'
    panelError.value = null

    // A conservative bound follows Verge's production cap. Ten workers avoid
    // overwhelming the controller/DNS/TLS stack on large subscriptions while
    // each member still owns its full timeout budget.
    const WORKERS = 10
    let measured = 0
    let worker = 0
    const runWorker = async (workerIndex: number): Promise<void> => {
      while (worker < members.length) {
        const member = members[worker]
        worker += 1
        try {
          // Verge-style small stagger avoids a synchronized DNS/TLS burst while
          // preserving each member's independent timeout budget.
          if (workerIndex > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * 150))
          if (await testGroupMember(group, member)) measured += 1
        } catch {
          // testGroupMember has already recorded the per-node error.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(WORKERS, members.length) }, (_, index) => runWorker(index)))

    // Only an empty scoreboard is a group-level failure — that mirrors the
    // kernel's own "all proxies timeout" 504, while individual dead nodes were
    // already labeled above and must not take the whole group down with them.
    if (selectedGroup.value === group && groupDelayGeneration.get(group) === batchGeneration) {
      if (measured === 0 && members.length > 0) {
        groupDelayStatus.value = 'error'
        panelError.value = '测速失败：所有节点均无有效延迟'
      } else {
        groupDelayStatus.value = 'ok'
      }
    }
    // Re-pull so the cards' `now`/`alive`/`fixed` reflect the fresh probes
    // (the same re-pull party does via `mutate()` after each result).
    try {
      const result = await window.desktop.mihomo.getProxies()
      if (groupDelayGeneration.get(group) !== batchGeneration) return
      proxies.value = result
      // Do not reconcile a different group if the user navigated while this
      // batch was running.
      if (selectedGroup.value === group && groupDelayGeneration.get(group) === batchGeneration) {
        const refreshedGroup = result.proxies[group]
        if (refreshedGroup) selectedMember.value = groupSelectedMember(refreshedGroup)
      }
    } catch {
      /* keep last good snapshot */
    }
  }

  function reset(): void {
    status.value = 'idle'
    lastError.value = null
    proxies.value = null
    selectedGroup.value = ''
    selectedMember.value = ''
    delayByNode.value = {}
    delayGeneration.clear()
    groupDelayGeneration.clear()
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
    groupSelectedMember,
    isSelectableGroup,
    load,
    selectGroup,
    setMode,
    selectNode,
    testNode,
    testAll,
    reset
  }
})
