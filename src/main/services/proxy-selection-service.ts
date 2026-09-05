import type { MihomoGateway, ProfileGateway } from '@shared/gateways'
import type { ProxySelectionStore } from '../profiles/proxy-selection-store'

/** Group types whose `now` member the user can pick (mirrors the renderer). */
const SELECTABLE_GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback'])

/**
 * Persists the user's node picks and replays them onto a freshly (re)started
 * kernel, so a restart or a profile switch restores the chosen nodes instead of
 * the config file's defaults (the sparkle/clash-party `selected`-cache model).
 *
 * The mihomo external controller holds selections only in memory; without this
 * replay every `start()` would silently revert each group to its first member.
 */
export class ProxySelectionService {
  constructor(
    private readonly mihomo: MihomoGateway,
    private readonly profiles: ProfileGateway,
    private readonly store: ProxySelectionStore
  ) {}

  /**
   * Resolve the id of the profile the NEXT controller write will apply to.
   * Called BEFORE the controller switch, so the selection is attributed to the
   * configuration that was active when the user made it — a profile switch,
   * kernel restart or quit that lands between the controller write and the
   * cache write can no longer misfile the pick (or lose it via a failing late
   * lookup).
   */
  async resolveActiveProfileId(): Promise<string | null> {
    try {
      const metas = await this.profiles.listProfiles()
      return metas.find((meta) => meta.active)?.id ?? null
    } catch {
      return null
    }
  }

  /**
   * Persist an already-attributed selection before the shared mutation boundary
   * is released. Storage remains best-effort, but callers wait for completion so
   * an immediate reload/quit cannot discard an accepted pick.
   */
  async recordSelection(profileId: string, group: string, node: string): Promise<void> {
    await this.store.set(profileId, group, node).catch(() => undefined)
  }

  /**
   * Re-apply every remembered selection for the active profile to the live
   * kernel. Best-effort per group: a group/node that no longer exists in the
   * (possibly updated) config is skipped, never aborts the remaining restores.
   * Returns the number of selections successfully restored.
   */
  async restoreSelections(): Promise<number> {
    const profileId = await this.currentProfileId()
    if (!profileId) return 0
    const remembered = await this.store.get(profileId)
    const groups = Object.entries(remembered)
    if (groups.length === 0) return 0

    // Read the live groups once so we only PUT selections that are both still
    // selectable and actually different from the kernel's current `now`.
    let live: Awaited<ReturnType<MihomoGateway['getProxies']>>['proxies'] | null = null
    try {
      live = (await this.mihomo.getProxies()).proxies
    } catch {
      return 0
    }

    let restored = 0
    for (const [group, node] of groups) {
      const target = live[group]
      if (!target || !SELECTABLE_GROUP_TYPES.has(target.type)) continue
      if (!Array.isArray(target.all) || !target.all.includes(node)) continue
      const selected = typeof target.fixed === 'string' && target.fixed.length > 0 ? target.fixed : target.now
      if (selected === node) continue
      try {
        await this.mihomo.selectProxy(group, node)
        restored++
      } catch {
        // A single rejected restore (stale node, provider mid-refresh) must not
        // block the remaining groups; the user can re-pick it in the UI.
      }
    }
    return restored
  }

  /** Drop the cache when a profile is deleted so its id never leaks stale picks. */
  async forgetProfile(profileId: string): Promise<void> {
    await this.store.deleteProfile(profileId)
  }

  private async currentProfileId(): Promise<string | null> {
    return this.resolveActiveProfileId()
  }
}
