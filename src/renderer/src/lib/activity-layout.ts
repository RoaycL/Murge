/**
 * 活动页卡片排列。
 *
 * 仪表盘始终是两列（见 base.css .dashboard-grid，每列再二分成两条子轨道）；每列从上往下堆叠卡片。
 * 横卡（延迟、连接、总计）占满一列一行，流量卡是正方形、占两行；上传、下载是半宽的正方形小卡，
 * 同一列里相邻的两张小卡并排共用一行，单独一张就占该行的左半边。
 * 用户可以把卡片拖到任一列的任意位置；顺序存在本机（localStorage）。
 *
 * 1.2.0 起加入 Surge 6 iPad 版的小组件（活动、网络、带宽、外部 IP、DNS、流量用量、
 * 流量排行、策略延迟、事件）。卡片可以隐藏（hidden），之后再从「添加卡片」放回来；
 * 旧版存下的排列里没有的新卡片自动补到较短的一列。
 */

export type ActivityCardId =
  | 'latency' | 'upload' | 'download' | 'connections' | 'traffic' | 'total'
  | 'activity' | 'network' | 'bandwidth' | 'externalIp' | 'dns' | 'usage' | 'ranking' | 'policyLatency' | 'events'
export type ActivityColumn = 'left' | 'right'
export interface ActivityLayout {
  left: ActivityCardId[]
  right: ActivityCardId[]
  /** Cards the user removed from the page (in the order they were hidden). */
  hidden: ActivityCardId[]
}

export const ACTIVITY_LAYOUT_STORAGE_KEY = 'activity-layout.v1'
export const ACTIVITY_CARDS: readonly ActivityCardId[] = Object.freeze([
  'latency', 'upload', 'download', 'connections', 'traffic', 'total',
  'activity', 'network', 'dns', 'bandwidth', 'externalIp', 'usage', 'ranking', 'policyLatency', 'events'
])
/** Grid rows each card spans. */
export const ACTIVITY_CARD_ROWS: Readonly<Record<ActivityCardId, number>> = Object.freeze({
  latency: 1, upload: 1, download: 1, connections: 1, traffic: 2, total: 1,
  activity: 2, network: 1, bandwidth: 1, externalIp: 1, dns: 1, usage: 2, ranking: 2, policyLatency: 2, events: 1
})

const HALF_CARDS: ReadonlySet<ActivityCardId> = new Set(['upload', 'download', 'dns', 'bandwidth'])

/** Half-width cards: two adjacent ones share a row. */
export function isHalfCard(id: ActivityCardId): boolean {
  return HALF_CARDS.has(id)
}

export function defaultActivityLayout(): ActivityLayout {
  return {
    left: ['latency', 'connections', 'total', 'network', 'externalIp', 'usage', 'policyLatency'],
    right: ['upload', 'download', 'traffic', 'dns', 'bandwidth', 'activity', 'ranking', 'events'],
    hidden: []
  }
}

const isCard = (value: unknown): value is ActivityCardId => typeof value === 'string' && (ACTIVITY_CARDS as readonly string[]).includes(value)

interface ColumnSlot { id: ActivityCardId; row: number; span: number; /** 0 = full width, 1 = left half, 2 = right half. */ half: 0 | 1 | 2 }

/** A column as rows: a full card alone, or up to two adjacent half cards side by side. */
function columnSlots(cards: readonly ActivityCardId[]): ColumnSlot[] {
  const out: ColumnSlot[] = []
  let row = 1
  let openHalf = false
  for (const id of cards) {
    if (isHalfCard(id)) {
      if (openHalf) {
        out.push({ id, row: row - 1, span: 1, half: 2 })
        openHalf = false
      } else {
        out.push({ id, row, span: 1, half: 1 })
        row += 1
        openHalf = true
      }
      continue
    }
    openHalf = false
    const span = ACTIVITY_CARD_ROWS[id]
    out.push({ id, row, span, half: 0 })
    row += span
  }
  return out
}

/** The column ends in a lone half card, so another half card can share its row. */
const hasOpenHalf = (cards: readonly ActivityCardId[]): boolean => {
  const slots = columnSlots(cards)
  return slots.length > 0 && slots[slots.length - 1].half === 1
}

const columnRows = (cards: readonly ActivityCardId[]): number => columnSlots(cards).reduce((max, slot) => Math.max(max, slot.row + slot.span - 1), 0)

/**
 * Keep known cards once each; cards missing from storage (new in an update) go to the shorter
 * column, except that a half card joins the column whose last row still has a free half.
 */
export function normalizeActivityLayout(value: unknown): ActivityLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultActivityLayout()
  const seen = new Set<ActivityCardId>()
  // 1.2.0-beta.2 之前上传和下载是一张合并的「speed」卡：在原位置拆成两张。
  const split = (list: unknown): unknown => Array.isArray(list) ? list.flatMap((id) => id === 'speed' ? ['upload', 'download'] : [id]) : list
  const pick = (list: unknown): ActivityCardId[] => {
    if (!Array.isArray(list)) return []
    const out: ActivityCardId[] = []
    for (const id of list) if (isCard(id) && !seen.has(id)) { seen.add(id); out.push(id) }
    return out
  }
  const raw = value as Record<string, unknown>
  const layout: ActivityLayout = { left: pick(split(raw.left)), right: pick(split(raw.right)), hidden: [] }
  layout.hidden = pick(raw.hidden)
  for (const id of ACTIVITY_CARDS) {
    if (seen.has(id)) continue
    const openHalf = isHalfCard(id) ? (['left', 'right'] as const).find((column) => hasOpenHalf(layout[column])) : undefined
    const column = openHalf ?? (columnRows(layout.right) < columnRows(layout.left) ? 'right' : 'left')
    layout[column].push(id)
  }
  return layout
}

export function parseActivityLayout(value: string | null): ActivityLayout {
  if (!value) return defaultActivityLayout()
  try {
    return normalizeActivityLayout(JSON.parse(value))
  } catch {
    return defaultActivityLayout()
  }
}

export function isDefaultActivityLayout(layout: ActivityLayout): boolean {
  return JSON.stringify(layout) === JSON.stringify(defaultActivityLayout())
}

export function cardPosition(layout: ActivityLayout, id: ActivityCardId): { column: ActivityColumn; index: number } {
  const index = layout.left.indexOf(id)
  return index >= 0 ? { column: 'left', index } : { column: 'right', index: layout.right.indexOf(id) }
}

/** Move a card to `index` of `column` (index counted without the card itself). */
export function moveActivityCard(layout: ActivityLayout, id: ActivityCardId, column: ActivityColumn, index: number): ActivityLayout {
  const next: ActivityLayout = {
    left: layout.left.filter((card) => card !== id),
    right: layout.right.filter((card) => card !== id),
    hidden: layout.hidden.filter((card) => card !== id)
  }
  const target = next[column]
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id)
  return next
}

/** Take a card off the page; it can be added back later. */
export function hideActivityCard(layout: ActivityLayout, id: ActivityCardId): ActivityLayout {
  if (layout.hidden.includes(id)) return layout
  return {
    left: layout.left.filter((card) => card !== id),
    right: layout.right.filter((card) => card !== id),
    hidden: [...layout.hidden, id]
  }
}

/** Put a hidden card back at the end of the shorter column (a half card fills an open half first). */
export function showActivityCard(layout: ActivityLayout, id: ActivityCardId): ActivityLayout {
  if (!layout.hidden.includes(id)) return layout
  const base: ActivityLayout = { left: [...layout.left], right: [...layout.right], hidden: layout.hidden.filter((card) => card !== id) }
  const openHalf = isHalfCard(id) ? (['left', 'right'] as const).find((column) => hasOpenHalf(base[column])) : undefined
  const column = openHalf ?? (columnRows(base.right) < columnRows(base.left) ? 'right' : 'left')
  base[column].push(id)
  return base
}

/**
 * CSS grid placement of every card on the four sub-tracks (two per column):
 * full cards span their column's two, half cards one.
 */
export function activityPlacement(layout: ActivityLayout): Partial<Record<ActivityCardId, { gridColumn: string; gridRow: string }>> {
  const out: Partial<Record<ActivityCardId, { gridColumn: string; gridRow: string }>> = {}
  ;(['left', 'right'] as const).forEach((column, columnIndex) => {
    const first = columnIndex * 2 + 1
    for (const slot of columnSlots(layout[column])) {
      const gridColumn = slot.half === 0 ? `${first} / span 2` : String(first + slot.half - 1)
      out[slot.id] = { gridColumn, gridRow: `${slot.row} / span ${slot.span}` }
    }
  })
  return out
}
