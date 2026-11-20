/**
 * 活动页卡片排列。
 *
 * 仪表盘始终是两列（见 base.css .dashboard-grid，每列再二分成两条子轨道）；每列从上往下堆叠卡片。
 * 横卡（延迟、连接、总计）占满一列一行，流量卡是正方形、占两行；上传、下载是半宽的正方形小卡，
 * 同一列里相邻的两张小卡并排共用一行，单独一张就占该行的左半边。
 * 用户可以把卡片拖到任一列的任意位置；顺序存在本机（localStorage）。
 */

export type ActivityCardId = 'latency' | 'upload' | 'download' | 'connections' | 'traffic' | 'total'
export type ActivityColumn = 'left' | 'right'
export interface ActivityLayout {
  left: ActivityCardId[]
  right: ActivityCardId[]
}

export const ACTIVITY_LAYOUT_STORAGE_KEY = 'activity-layout.v1'
export const ACTIVITY_CARDS: readonly ActivityCardId[] = Object.freeze(['latency', 'upload', 'download', 'connections', 'traffic', 'total'])
/** Grid rows each card spans. */
export const ACTIVITY_CARD_ROWS: Readonly<Record<ActivityCardId, number>> = Object.freeze({ latency: 1, upload: 1, download: 1, connections: 1, traffic: 2, total: 1 })

/** Half-width cards: two adjacent ones share a row. */
export function isHalfCard(id: ActivityCardId): boolean {
  return id === 'upload' || id === 'download'
}

export function defaultActivityLayout(): ActivityLayout {
  return { left: ['latency', 'connections', 'total'], right: ['upload', 'download', 'traffic'] }
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

const columnRows = (cards: readonly ActivityCardId[]): number => columnSlots(cards).reduce((max, slot) => Math.max(max, slot.row + slot.span - 1), 0)

/** Keep known cards once each; cards missing from storage (new in an update) go to the shorter column. */
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
  const layout: ActivityLayout = { left: pick(split(raw.left)), right: pick(split(raw.right)) }
  for (const id of ACTIVITY_CARDS) {
    if (seen.has(id)) continue
    const column = columnRows(layout.right) < columnRows(layout.left) ? 'right' : 'left'
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
  const next: ActivityLayout = { left: layout.left.filter((card) => card !== id), right: layout.right.filter((card) => card !== id) }
  const target = next[column]
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id)
  return next
}

/**
 * CSS grid placement of every card on the four sub-tracks (two per column):
 * full cards span their column's two, half cards one.
 */
export function activityPlacement(layout: ActivityLayout): Record<ActivityCardId, { gridColumn: string; gridRow: string }> {
  const out = {} as Record<ActivityCardId, { gridColumn: string; gridRow: string }>
  ;(['left', 'right'] as const).forEach((column, columnIndex) => {
    const first = columnIndex * 2 + 1
    for (const slot of columnSlots(layout[column])) {
      const gridColumn = slot.half === 0 ? `${first} / span 2` : String(first + slot.half - 1)
      out[slot.id] = { gridColumn, gridRow: `${slot.row} / span ${slot.span}` }
    }
  })
  return out
}
