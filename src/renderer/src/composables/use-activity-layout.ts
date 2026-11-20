import { computed, nextTick, onBeforeUnmount, ref, type Ref } from 'vue'
import {
  ACTIVITY_LAYOUT_STORAGE_KEY, activityPlacement, cardPosition, defaultActivityLayout, isDefaultActivityLayout, isHalfCard,
  moveActivityCard, parseActivityLayout, type ActivityCardId, type ActivityColumn, type ActivityLayout
} from '../lib/activity-layout'

function readStored(): string | null {
  try { return window.localStorage.getItem(ACTIVITY_LAYOUT_STORAGE_KEY) } catch { return null }
}

/** Pointer travel before a press on a card turns into a drag (a shorter press stays a click). */
const DRAG_THRESHOLD = 6
/** How long a card is held still before the page enters 整理 (arrange) mode, like iOS's home screen. */
export const LONG_PRESS_MS = 450
/** Presses here keep their own behavior (typing, choosing) and never start a long press. */
const NO_DRAG = 'input, textarea, select, .app-select'
/** Presses here never leave arrange mode (the 完成 button, menus opened from a card). */
const KEEP_EDITING = '[data-card], .activity-arrange-done, .popover-menu, [role="menu"]'

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
 * 活动页卡片拖动排序. Like moving app icons on iOS: a plain press, drag or
 * scroll on a card behaves normally (the traffic list scrolls, buttons
 * click); holding a card still for LONG_PRESS_MS enters arrange mode, where
 * every card jiggles and can be dragged. Arrange mode ends with 完成, Esc,
 * or a press outside the cards.
 *
 * Cards stay in place in the DOM and are placed on the grid from the saved
 * order, so a drag never remounts a card. While dragging, the lifted card
 * follows the pointer and the other cards slide (FLIP) to the slot it would
 * drop into.
 */
export function useActivityLayout(grid: Ref<HTMLElement | null>) {
  const layout = ref<ActivityLayout>(parseActivityLayout(readStored()))
  const placement = computed(() => activityPlacement(layout.value))
  const isDefault = computed(() => isDefaultActivityLayout(layout.value))
  const dragging = ref<ActivityCardId | null>(null)
  /** Arrange mode: cards jiggle and any press on one can drag it. */
  const editing = ref(false)
  const offset = ref({ x: 0, y: 0 })
  let drag: DragState | null = null
  let pressTimer: number | undefined
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

  /**
   * The slot under the pointer: the grid half picks the column; a full card
   * counts as before the slot once the pointer is past its middle, a half
   * card once the pointer is below it or to the right of its middle on its row.
   */
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
      if (!el) continue
      const top = rect.top + el.offsetTop
      const bottom = top + el.offsetHeight
      const before = isHalfCard(id)
        ? lastPointer.y > bottom || (lastPointer.y >= top && lastPointer.x > rect.left + el.offsetLeft + el.offsetWidth / 2)
        : top + el.offsetHeight / 2 < lastPointer.y
      if (before) index++
    }
    return { column, index }
  }

  function onMove(event: PointerEvent): void {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    lastPointer = { x: event.clientX, y: event.clientY }
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD) return
      if (!editing.value) {
        // Moved before the long press: an ordinary drag/scroll/selection, not ours.
        cancelPress()
        return
      }
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

  function unlisten(): void {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
  }

  function cancelPress(): void {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
    drag = null
    unlisten()
  }

  function stop(event: PointerEvent): void {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    window.clearTimeout(pressTimer)
    pressTimer = undefined
    drag = null
    unlisten()
    // A long press ended without a drag: swallow its click, but only that one.
    if (suppressClick) window.setTimeout(() => { suppressClick = false }, 80)
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

  function startEditing(): void {
    if (editing.value) return
    editing.value = true
    document.addEventListener('pointerdown', onOutsidePointerDown)
    window.addEventListener('keydown', onKeyDown)
  }

  function stopEditing(): void {
    if (!editing.value) return
    editing.value = false
    document.removeEventListener('pointerdown', onOutsidePointerDown)
    window.removeEventListener('keydown', onKeyDown)
  }

  function onOutsidePointerDown(event: PointerEvent): void {
    if (drag) return
    const source = event.target as HTMLElement | null
    if (!source?.closest(KEEP_EDITING)) stopEditing()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !drag) stopEditing()
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || drag) return
    const source = event.target as HTMLElement | null
    const card = source?.closest<HTMLElement>('[data-card]')
    const box = grid.value
    if (!card || !box) return
    if (!editing.value && source?.closest(NO_DRAG)) return
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
    if (editing.value) {
      // In arrange mode a press grabs the card right away (no text selection).
      event.preventDefault()
      return
    }
    window.clearTimeout(pressTimer)
    pressTimer = window.setTimeout(() => {
      pressTimer = undefined
      if (!drag) return
      startEditing()
      // The release of this press is not a click on the button it started on.
      suppressClick = true
      window.getSelection()?.removeAllRanges()
    }, LONG_PRESS_MS)
  }

  function onClickCapture(event: MouseEvent): void {
    // In arrange mode cards are only moved: their buttons and links stay inert.
    const onCard = Boolean((event.target as HTMLElement | null)?.closest('[data-card]'))
    if (!suppressClick && !(editing.value && onCard)) return
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
    window.clearTimeout(pressTimer)
    unlisten()
    stopEditing()
    document.body.classList.remove('activity-card-dragging')
  })

  return { layout, isDefault, dragging, editing, startEditing, stopEditing, cardStyle, onPointerDown, onClickCapture, moveBy, moveAcross, reset }
}
