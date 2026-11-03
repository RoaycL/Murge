import type { AppIconName } from '../components/AppIcon.vue'

/**
 * 侧边栏布局（更多 › 外观 › 侧边栏布局）。
 *
 * 侧栏按大类分组；用户可以在大类内部调整顺序、隐藏或显示某一项，但不能把一项
 * 挪到别的大类。「更多」固定在侧栏底部，不参与配置，所以任何时候都能回到设置。
 * 被隐藏的页面在「更多」页里仍有入口。
 */

export type SidebarGroupId = 'client' | 'proxy' | 'http' | 'config'
export type SidebarItemId =
  | 'activity' | 'overview' | 'connections' | 'processes' | 'devices'
  | 'policies' | 'rules'
  | 'mitm' | 'rewrite'
  | 'profiles' | 'overrides' | 'resources' | 'substore'

export interface SidebarItemDefinition {
  id: SidebarItemId
  to: string
  label: string
  icon: AppIconName
  /** 设备与 Sub-Store 默认收在「更多」里，用户可以把它们放回侧栏。 */
  defaultHidden?: boolean
}

export interface SidebarGroupDefinition {
  id: SidebarGroupId
  /** 侧栏里显示的分组标题；第一组（客户端）在侧栏中不显示标题。 */
  label: string
  /** 外观设置里显示的分组名。 */
  settingsLabel: string
  items: SidebarItemDefinition[]
}

export const SIDEBAR_GROUPS: readonly SidebarGroupDefinition[] = Object.freeze([
  {
    id: 'client',
    label: '',
    settingsLabel: '客户端',
    items: [
      { id: 'activity', to: '/activity', label: '活动', icon: 'activity' },
      { id: 'overview', to: '/overview', label: '概览', icon: 'overview' },
      { id: 'connections', to: '/connections', label: '连接', icon: 'connections' },
      { id: 'processes', to: '/processes', label: '进程', icon: 'processes' },
      { id: 'devices', to: '/devices', label: '设备', icon: 'devices', defaultHidden: true }
    ]
  },
  {
    id: 'proxy',
    label: '代理',
    settingsLabel: '代理',
    items: [
      { id: 'policies', to: '/policies', label: '策略', icon: 'policies' },
      { id: 'rules', to: '/rules', label: '规则', icon: 'rules' }
    ]
  },
  {
    id: 'http',
    label: 'HTTP',
    settingsLabel: 'HTTP',
    items: [
      { id: 'mitm', to: '/mitm', label: '解密', icon: 'mitm' },
      { id: 'rewrite', to: '/rewrite', label: '重写', icon: 'rewrite' }
    ]
  },
  {
    id: 'config',
    label: '配置',
    settingsLabel: '配置',
    items: [
      { id: 'profiles', to: '/profiles', label: '配置', icon: 'profiles' },
      { id: 'overrides', to: '/overrides', label: '覆写', icon: 'overrides' },
      { id: 'resources', to: '/resources', label: '外部资源', icon: 'resources' },
      { id: 'substore', to: '/substore', label: 'Sub-Store', icon: 'substore', defaultHidden: true }
    ]
  }
] satisfies SidebarGroupDefinition[])

export interface SidebarLayoutEntry { id: SidebarItemId; visible: boolean }
/** 每个大类一份有序列表；键只能是已知大类，列表里只能是该大类自己的项。 */
export type SidebarLayout = Record<SidebarGroupId, SidebarLayoutEntry[]>

export const SIDEBAR_LAYOUT_STORAGE_KEY = 'sidebar-layout.v1'

const ITEMS_BY_ID = new Map<SidebarItemId, SidebarItemDefinition>(
  SIDEBAR_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item] as const))
)

export function sidebarItem(id: SidebarItemId): SidebarItemDefinition {
  return ITEMS_BY_ID.get(id) as SidebarItemDefinition
}

export function defaultSidebarLayout(): SidebarLayout {
  return Object.fromEntries(SIDEBAR_GROUPS.map((group) => [
    group.id,
    group.items.map((item) => ({ id: item.id, visible: item.defaultHidden !== true }))
  ])) as SidebarLayout
}

/**
 * 把任意（可能来自旧版本或被手改过的）值整理成完整布局：
 * - 只接受属于本大类的项，跨组、未知或重复的项一律丢弃；
 * - 新版本新增、存储里没有的项按默认可见性追加在本组末尾。
 */
export function normalizeSidebarLayout(value: unknown): SidebarLayout {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const layout = {} as SidebarLayout
  for (const group of SIDEBAR_GROUPS) {
    const allowed = new Set<string>(group.items.map((item) => item.id))
    const seen = new Set<string>()
    const entries: SidebarLayoutEntry[] = []
    const stored = Array.isArray(source[group.id]) ? source[group.id] as unknown[] : []
    for (const raw of stored) {
      if (!raw || typeof raw !== 'object') continue
      const { id, visible } = raw as { id?: unknown; visible?: unknown }
      if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) continue
      seen.add(id)
      const definition = sidebarItem(id as SidebarItemId)
      entries.push({ id: id as SidebarItemId, visible: typeof visible === 'boolean' ? visible : definition.defaultHidden !== true })
    }
    for (const item of group.items) {
      if (!seen.has(item.id)) entries.push({ id: item.id, visible: item.defaultHidden !== true })
    }
    layout[group.id] = entries
  }
  return layout
}

export function parseSidebarLayout(value: string | null): SidebarLayout {
  if (!value) return defaultSidebarLayout()
  try {
    return normalizeSidebarLayout(JSON.parse(value))
  } catch {
    return defaultSidebarLayout()
  }
}

export function isDefaultSidebarLayout(layout: SidebarLayout): boolean {
  return JSON.stringify(normalizeSidebarLayout(layout)) === JSON.stringify(defaultSidebarLayout())
}

/** 在同一大类内把第 from 项移到第 to 位；越界时原样返回。 */
export function moveWithinGroup(layout: SidebarLayout, group: SidebarGroupId, from: number, to: number): SidebarLayout {
  const entries = layout[group]
  if (!entries || from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return layout
  const next = entries.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return { ...layout, [group]: next }
}

export function setItemVisible(layout: SidebarLayout, id: SidebarItemId, visible: boolean): SidebarLayout {
  const group = SIDEBAR_GROUPS.find((candidate) => candidate.items.some((item) => item.id === id))
  if (!group) return layout
  return { ...layout, [group.id]: layout[group.id].map((entry) => entry.id === id ? { ...entry, visible } : entry) }
}

export interface ResolvedSidebarGroup { id: SidebarGroupId; label: string; items: SidebarItemDefinition[] }

/** 侧栏实际渲染的分组：只含可见项，空组整个不显示。 */
export function visibleSidebarGroups(layout: SidebarLayout): ResolvedSidebarGroup[] {
  return SIDEBAR_GROUPS
    .map((group) => ({
      id: group.id,
      label: group.label,
      items: layout[group.id].filter((entry) => entry.visible).map((entry) => sidebarItem(entry.id))
    }))
    .filter((group) => group.items.length > 0)
}

/** 当前没有出现在侧栏里的页面，按分组与组内顺序排列；「更多」页为它们保留入口。 */
export function hiddenSidebarItems(layout: SidebarLayout): SidebarItemDefinition[] {
  return SIDEBAR_GROUPS.flatMap((group) => layout[group.id].filter((entry) => !entry.visible).map((entry) => sidebarItem(entry.id)))
}
