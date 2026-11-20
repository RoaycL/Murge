/**
 * 活动页卡片排列。
 *
 * 仪表盘始终是两列（见 base.css .dashboard-grid）；每列从上往下堆叠卡片。
 * 横卡（延迟、连接、总计）和上传/下载速率组各占一行，流量卡是正方形、占两行。
 * 用户可以把卡片拖到任一列的任意位置；顺序存在本机（localStorage）。
 */

export type ActivityCardId = 'latency' | 'speed' | 'connections' | 'traffic' | 'total'
export type ActivityColumn = 'left' | 'right'
export interface ActivityLayout {
  left: ActivityCardId[]
  right: ActivityCardId[]
}

export const ACTIVITY_LAYOUT_STORAGE_KEY = 'activity-layout.v1'
export const ACTIVITY_CARDS: readonly ActivityCardId[] = Object.freeze(['latency', 'speed', 'connections', 'traffic', 'total'])
/** Grid rows each card spans. */
export const ACTIVITY_CARD_ROWS: Readonly<Record<ActivityCardId, number>> = Object.freeze({ latency: 1, speed: 1, connections: 1, traffic: 2, total: 1 })

export function defaultActivityLayout(): ActivityLayout {
  return { left: ['latency', 'connections', 'total'], right: ['speed', 'traffic'] }
}

const isCard = (value: unknown): value is ActivityCardId => typeof value === 'string' && (ACTIVITY_CARDS as readonly string[]).includes(value)

const columnRows = (cards: readonly ActivityCardId[]): number => cards.reduce((sum, id) => sum + ACTIVITY_CARD_ROWS[id], 0)

/** Keep known cards once each; cards missing from storage (new in an update) go to the shorter column. */
export function normalizeActivityLayout(value: unknown): ActivityLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultActivityLayout()
  const seen = new Set<ActivityCardId>()
  const pick = (list: unknown): ActivityCardId[] => {
    if (!Array.isArray(list)) return []
    const out: ActivityCardId[] = []
    for (const id of list) if (isCard(id) && !seen.has(id)) { seen.add(id); out.push(id) }
    return out
  }
  const raw = value as Record<string, unknown>
  const layout: ActivityLayout = { left: pick(raw.left), right: pick(raw.right) }
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

/** CSS grid placement of every card: column 1/2, rows stacked from the top of each column. */
export function activityPlacement(layout: ActivityLayout): Record<ActivityCardId, { gridColumn: string; gridRow: string }> {
  const out = {} as Record<ActivityCardId, { gridColumn: string; gridRow: string }>
  ;(['left', 'right'] as const).forEach((column, columnIndex) => {
    let row = 1
    for (const id of layout[column]) {
      const span = ACTIVITY_CARD_ROWS[id]
      out[id] = { gridColumn: String(columnIndex + 1), gridRow: `${row} / span ${span}` }
      row += span
    }
  })
  return out
}
