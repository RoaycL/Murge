import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  EMPTY_LOCAL_STATE,
  newLocalId,
  plainClone,
  ruleIdentity,
  parseRuleLine,
  tailnetRulesFor,
  type LocalNode,
  type LocalRule,
  type LocalSettings,
  type LocalState,
  type RuleEdit
} from '@shared/local'
import { toProtocolError } from '@shared/protocol-errors'

/**
 * 本地节点与规则. The Rust service owns the semantics; every change sends the
 * whole settings object and re-reads the authoritative snapshot (which also
 * says which edits no longer match the subscription).
 */
export const useLocalStore = defineStore('local', () => {
  const state = ref<LocalState>(plainClone(EMPTY_LOCAL_STATE))
  const loaded = ref(false)
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  const settings = computed(() => state.value.settings)
  const profileId = computed(() => state.value.profile?.id ?? null)
  const profileEdits = computed<RuleEdit[]>(() => (profileId.value ? settings.value.profileEdits[profileId.value] ?? [] : []))

  /** Identities of rules this layer injects, to tag `/rules` rows. */
  const localRuleIdentities = computed(() => {
    const set = new Set<string>()
    const add = (line: string) => {
      const parsed = parseRuleLine(line)
      if (parsed) set.add(ruleIdentity(parsed.type, parsed.payload, parsed.target))
    }
    for (const rule of settings.value.rules) if (rule.enabled) add(rule.rule)
    for (const node of settings.value.nodes) {
      if (node.enabled && node.tailnetRules && String(node.config.type).toLowerCase() === 'tailscale') {
        for (const line of tailnetRulesFor(node.config.name)) add(line)
      }
    }
    return set
  })

  /** `/rules` identity of an edited subscription rule (after the edit) → the edit. */
  const editedIdentities = computed(() => {
    const map = new Map<string, RuleEdit>()
    for (const edit of profileEdits.value) {
      if (edit.action === 'retarget' && edit.newTarget) map.set(ruleIdentity(edit.ruleType, edit.payload, edit.newTarget), edit)
      if (edit.action === 'replace' && edit.replacement) {
        const parsed = parseRuleLine(edit.replacement)
        if (parsed) map.set(ruleIdentity(parsed.type, parsed.payload, parsed.target), edit)
      }
    }
    return map
  })

  async function refresh(): Promise<void> {
    try {
      state.value = await window.desktop.local.getState()
      loaded.value = true
      lastError.value = null
    } catch (error) {
      lastError.value = toProtocolError(error).message
    }
  }

  /** Save the next settings; returns the error message (null on success). */
  async function save(next: LocalSettings): Promise<string | null> {
    if (busy.value) return '正在处理上一个操作'
    busy.value = true
    try {
      state.value = await window.desktop.local.save(plainClone(next))
      lastError.value = null
      return null
    } catch (error) {
      const message = toProtocolError(error).message
      lastError.value = message
      return message
    } finally {
      busy.value = false
    }
  }

  const clone = (): LocalSettings => plainClone(settings.value)

  function upsertNode(node: LocalNode): Promise<string | null> {
    const next = clone()
    const draft = { ...node, id: node.id || newLocalId() }
    const index = next.nodes.findIndex((item) => item.id === draft.id)
    if (index >= 0) next.nodes[index] = draft
    else next.nodes.push(draft)
    return save(next)
  }

  function addNodes(nodes: LocalNode[]): Promise<string | null> {
    const next = clone()
    next.nodes.push(...nodes.map((node) => ({ ...node, id: node.id || newLocalId() })))
    return save(next)
  }

  function removeNode(id: string): Promise<string | null> {
    const next = clone()
    next.nodes = next.nodes.filter((node) => node.id !== id)
    return save(next)
  }

  function setNodeEnabled(id: string, enabled: boolean): Promise<string | null> {
    const next = clone()
    const node = next.nodes.find((item) => item.id === id)
    if (node) node.enabled = enabled
    return save(next)
  }

  function upsertRule(rule: LocalRule): Promise<string | null> {
    const next = clone()
    const draft = { ...rule, id: rule.id || newLocalId() }
    const index = next.rules.findIndex((item) => item.id === draft.id)
    if (index >= 0) next.rules[index] = draft
    else next.rules.unshift(draft)
    return save(next)
  }

  function removeRule(id: string): Promise<string | null> {
    const next = clone()
    next.rules = next.rules.filter((rule) => rule.id !== id)
    return save(next)
  }

  function setRuleEnabled(id: string, enabled: boolean): Promise<string | null> {
    const next = clone()
    const rule = next.rules.find((item) => item.id === id)
    if (rule) rule.enabled = enabled
    return save(next)
  }

  function moveRule(id: string, offset: -1 | 1): Promise<string | null> {
    const next = clone()
    const index = next.rules.findIndex((rule) => rule.id === id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= next.rules.length) return Promise.resolve(null)
    const [rule] = next.rules.splice(index, 1)
    next.rules.splice(target, 0, rule)
    return save(next)
  }

  /** Add or replace the edit for one subscription rule of the active profile. */
  function setEdit(edit: Omit<RuleEdit, 'id'> & { id?: string }): Promise<string | null> {
    const id = profileId.value
    if (!id) return Promise.resolve('当前没有活动的订阅')
    const next = clone()
    const list = (next.profileEdits[id] ?? []).filter(
      (item) => item.id !== edit.id && ruleIdentity(item.ruleType, item.payload, item.target) !== ruleIdentity(edit.ruleType, edit.payload, edit.target)
    )
    list.push({ ...edit, id: edit.id || newLocalId() })
    next.profileEdits[id] = list
    return save(next)
  }

  function removeEdit(editId: string): Promise<string | null> {
    const id = profileId.value
    if (!id) return Promise.resolve(null)
    const next = clone()
    next.profileEdits[id] = (next.profileEdits[id] ?? []).filter((item) => item.id !== editId)
    if (!next.profileEdits[id].length) delete next.profileEdits[id]
    return save(next)
  }

  function setTailscaleCoexist(enabled: boolean): Promise<string | null> {
    const next = clone()
    next.tailscaleCoexist = enabled
    return save(next)
  }

  return {
    state,
    loaded,
    busy,
    lastError,
    settings,
    profileId,
    profileEdits,
    localRuleIdentities,
    editedIdentities,
    refresh,
    save,
    upsertNode,
    addNodes,
    removeNode,
    setNodeEnabled,
    upsertRule,
    removeRule,
    setRuleEnabled,
    moveRule,
    setEdit,
    removeEdit,
    setTailscaleCoexist
  }
})
