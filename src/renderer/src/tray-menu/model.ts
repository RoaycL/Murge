/**
 * The tray popup's view model — pure, so the page logic is unit-testable.
 *
 * The Rust side (`src-tauri/src/tray_popup.rs`) sends the exact tree the
 * native menu is built from; this module only decides how each row is drawn.
 */

export type TrayItemKind = 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu'

export interface TrayItem {
  id: string
  label: string
  enabled: boolean
  checked: boolean
  kind: TrayItemKind
  children: TrayItem[]
}

export interface TrayModel {
  title: string
  status: string
  accent: 'idle' | 'proxy' | 'tun' | string
  theme: 'light' | 'dark'
  items: TrayItem[]
}

export const EMPTY_MODEL: TrayModel = { title: 'Murge', status: '', accent: 'idle', theme: 'light', items: [] }

/** Row metrics, mirrored by `tray_popup.rs` (logical px). */
export const ROW_HEIGHT = 30
export const SEPARATOR_HEIGHT = 9
export const HEADER_HEIGHT = 52
export const PANEL_PADDING = 6

export type RowIcon =
  | 'window' | 'mode' | 'group' | 'pulse' | 'process' | 'proxy' | 'tun' | 'terminal'
  | 'profile' | 'folder' | 'update' | 'quit' | 'warning' | null

/** `出站模式 · 规则` → label + trailing detail. */
export function splitLabel(label: string): { text: string; detail: string } {
  const at = label.indexOf(' · ')
  if (at < 0) return { text: label, detail: '' }
  return { text: label.slice(0, at), detail: label.slice(at + 3) }
}

/** Root-page rows get a leading glyph; drill-down rows stay plain. */
export function iconFor(item: TrayItem): RowIcon {
  const { id } = item
  if (id === 'show') return 'window'
  if (id === 'outbound-mode') return 'mode'
  if (id.startsWith('group:')) return 'group'
  if (id === 'network-quality') return 'pulse'
  if (id === 'processes') return 'process'
  if (id === 'system-proxy') return 'proxy'
  if (id === 'tun') return 'tun'
  if (id === 'copy-terminal-proxy') return 'terminal'
  if (id === 'configuration') return 'profile'
  if (id === 'open-directory') return 'folder'
  if (id === 'check-update') return 'update'
  if (id === 'quit' || id === 'force-quit') return 'quit'
  if (id === 'quit-blocked' || id === 'quitting') return 'warning'
  return null
}

/** Toggles render as switches on the root page. */
export function isSwitch(item: TrayItem): boolean {
  return item.kind === 'checkbox' && (item.id === 'system-proxy' || item.id === 'tun')
}

/** The outbound mode renders inline as a segmented control. */
export function isSegmented(item: TrayItem): boolean {
  return item.id === 'outbound-mode' && item.kind === 'submenu'
}

export function isDanger(item: TrayItem): boolean {
  return item.id === 'force-quit'
}

/** Rows the keyboard can land on (in page order). */
export function focusable(items: TrayItem[]): TrayItem[] {
  return items.filter((item) => item.kind !== 'separator' && item.enabled && !isSegmented(item))
}

/** Follow a drill-down path (submenu ids) into the current tree. A path whose
 * submenu vanished after a refresh falls back to the deepest valid page. */
export function resolvePage(items: TrayItem[], path: string[]): { items: TrayItem[]; trail: TrayItem[] } {
  let current = items
  const trail: TrayItem[] = []
  for (const id of path) {
    const next = current.find((item) => item.id === id && item.kind === 'submenu')
    if (!next || !next.enabled) break
    trail.push(next)
    current = next.children
  }
  return { items: current, trail }
}

/** Natural height of a page, before the work-area clamp. */
export function pageHeight(items: TrayItem[]): number {
  const rows = items.reduce((sum, item) => sum + (item.kind === 'separator' ? SEPARATOR_HEIGHT : ROW_HEIGHT), 0)
  return HEADER_HEIGHT + PANEL_PADDING * 2 + rows
}

export function normalizeModel(value: unknown): TrayModel {
  if (!value || typeof value !== 'object') return EMPTY_MODEL
  const raw = value as Partial<TrayModel>
  return {
    title: typeof raw.title === 'string' ? raw.title : 'Murge',
    status: typeof raw.status === 'string' ? raw.status : '',
    accent: typeof raw.accent === 'string' ? raw.accent : 'idle',
    theme: raw.theme === 'dark' ? 'dark' : 'light',
    items: Array.isArray(raw.items) ? raw.items : []
  }
}
