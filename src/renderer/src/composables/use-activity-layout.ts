import { computed, nextTick, onBeforeUnmount, ref, type Ref } from 'vue'
import {
  ACTIVITY_LAYOUT_STORAGE_KEY, activityPlacement, cardPosition, defaultActivityLayout, isDefaultActivityLayout,
  moveActivityCard, parseActivityLayout, type ActivityCardId, type ActivityColumn, type ActivityLayout
} from '../lib/activity-layout'

function readStored(): string | null {
  try { return window.localStorage.getItem(ACTIVITY_LAYOUT_STORAGE_KEY) } catch { return null }
}

/** Pointer travel before a press on a card turns into a drag (a shorter press stays a click). */
const DRAG_THRESHOLD = 6
/** Presses here keep their own behavior (typing, choosing) and never start a drag. */
const NO_DRAG = 'input, textarea, select, .app-select'

interface DragState {
  id: ActivityCardId
  pointerId: number
  startX: number
  startY: number
  /** Pointer offset inside the card's own (untransformed) box. */
  grabX: number
  grabY: number
  active: boolean
}

/**
 * 活动页卡片拖动排序. Cards stay in place in the DOM and are placed on the
 * two-column grid from the saved order, so a drag never remounts a card.
 * While dragging, the lifted card follows the pointer and the other cards
 * slide (FLIP) to the slot it would drop into.
 */
export function useActivityLayout(grid: Ref<HTMLElement | null>) {
  const layout = ref<ActivityLayout>(parseActivityLayout(readStored()))
  const placement = computed(() => activityPlacement(layout.value))
  const isDefault = computed(() => isDefaultActivityLayout(layout.value))
  const dragging = ref<ActivityCardId | null>(null)
  const offset = ref({ x: 0, y: 0 })
  let drag: DragState | null = null
  let lastPointer = { x: 0, y: 0 }
  let suppressClick = false

  function persist(): void {
    try { window.localStorage.setItem(ACTIVITY_LAYOUT_STORAGE_KEY, JSON.stringify(layout.value)) } catch { /* 存不下时本次会话仍生效 */ }
  }

  const cardEl = (id: ActivityCardId): HTMLElement | null => grid.value?.querySelector<HTMLElement>(`[data-card="${id}"]`) ?? null

  /** Commit a new order and slide the other cards from their old slots (FLIP). */
  async function commit(next: ActivityLayout, keep?: ActivityCardId): Promise<void> {
    const before = new Map<HTMLElement, { x: number; y: number }>()
    grid.value?.querySelectorAll<HTMLElement>('[data-card]').forEach((el) => before.set(el, { x: el.offsetLeft, y: el.offsetTop }))
    layout.value = next
    await nextTick()
    for (const [el, from] of before) {
      if (el.dataset.card === keep) continue
      const dx = from.x - el.offsetLeft
      const dy = from.y - el.offsetTop
      if (!dx && !dy) continue
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      void el.offsetWidth
      el.style.transition = 'transform 180ms ease'
      el.style.transform = ''
    }
  }

  function follow(): void {
    const state = drag
    const box = grid.value
    const el = state && cardEl(state.id)
    if (!state || !box || !el) return
    const rect = box.getBoundingClientRect()
    offset.value = { x: lastPointer.x - state.grabX - (rect.left + el.offsetLeft), y: lastPointer.y - state.grabY - (rect.top + el.offsetTop) }
  }

  /** The slot under the pointer: the grid half picks the column, the other cards' centers the index. */
  function target(): { column: ActivityColumn; index: number } | null {
    const state = drag
    const box = grid.value
    if (!state || !box) return null
    const rect = box.getBoundingClientRect()
    const column: ActivityColumn = lastPointer.x < rect.left + rect.width / 2 ? 'left' : 'right'
    let index = 0
    for (const id of layout.value[column]) {
      if (id === state.id) continue
      const el = cardEl(id)
      if (el && rect.top + el.offsetTop + el.offsetHeight / 2 < lastPointer.y) index++
    }
    return { column, index }
  }

  function onMove(event: PointerEvent): void {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    lastPointer = { x: event.clientX, y: event.clientY }
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD) return
      state.active = true
      dragging.value = state.id
      document.body.classList.add('activity-card-dragging')
    }
    event.preventDefault()
    const slot = target()
    const current = cardPosition(layout.value, state.id)
    if (slot && (slot.column !== current.column || slot.index !== current.index)) {
      void commit(moveActivityCard(layout.value, state.id, slot.column, slot.index), state.id).then(follow)
    }
    follow()
  }

  function stop(event: PointerEvent): void {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    drag = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    if (!state.active) return
    // The release is not a click on whatever button the drag started from.
    suppressClick = true
    window.setTimeout(() => { suppressClick = false }, 80)
    document.body.classList.remove('activity-card-dragging')
    const el = cardEl(state.id)
    // Settle the lifted card into its slot instead of jumping.
    if (el) {
      el.style.transition = 'none'
      el.style.transform = `translate(${offset.value.x}px, ${offset.value.y}px)`
      dragging.value = null
      offset.value = { x: 0, y: 0 }
      void el.offsetWidth
      el.style.transition = 'transform 180ms ease'
      el.style.transform = ''
    } else {
      dragging.value = null
    }
    persist()
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || drag) return
    const source = event.target as HTMLElement | null
    const card = source?.closest<HTMLElement>('[data-card]')
    const box = grid.value
    if (!card || !box || source?.closest(NO_DRAG)) return
    const rect = box.getBoundingClientRect()
    drag = {
      id: card.dataset.card as ActivityCardId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - (rect.left + card.offsetLeft),
      grabY: event.clientY - (rect.top + card.offsetTop),
      active: false
    }
    lastPointer = { x: event.clientX, y: event.clientY }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  function onClickCapture(event: MouseEvent): void {
    if (!suppressClick) return
    suppressClick = false
    event.preventDefault()
    event.stopPropagation()
  }

  /** Inline style of a card: its grid slot, plus the drag offset while lifted. */
  function cardStyle(id: ActivityCardId): Record<string, string> {
    const slot = placement.value[id]
    if (dragging.value !== id) return { gridColumn: slot.gridColumn, gridRow: slot.gridRow }
    return { gridColumn: slot.gridColumn, gridRow: slot.gridRow, transform: `translate(${offset.value.x}px, ${offset.value.y}px)` }
  }

  function moveBy(id: ActivityCardId, delta: -1 | 1): void {
    const { column, index } = cardPosition(layout.value, id)
    const next = index + delta
    if (next < 0 || next >= layout.value[column].length) return
    void commit(moveActivityCard(layout.value, id, column, next)).then(persist)
  }

  function moveAcross(id: ActivityCardId): void {
    const { column, index } = cardPosition(layout.value, id)
    const other: ActivityColumn = column === 'left' ? 'right' : 'left'
    void commit(moveActivityCard(layout.value, id, other, index)).then(persist)
  }

  function reset(): void {
    void commit(defaultActivityLayout()).then(persist)
  }

  onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    document.body.classList.remove('activity-card-dragging')
  })

  return { layout, isDefault, dragging, cardStyle, onPointerDown, onClickCapture, moveBy, moveAcross, reset }
}
