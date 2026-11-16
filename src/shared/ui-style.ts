/**
 * 自定义界面样式（字体、强调色、字号、自定义 CSS）。
 *
 * 保存在应用数据目录的 `ui-style.json`（随配置备份一起导出/恢复），渲染进程另存一份
 * localStorage 缓存，只用来避免启动时先闪一下默认样式。主进程侧的校验在
 * `src-tauri/src/ui_style.rs`，规则与这里逐字段一致。
 */

export type UiFontScale = 'small' | 'default' | 'large' | 'larger'

export interface UiStyle {
  /** 强调色 `#rrggbb`；空字符串表示使用内置蓝色。 */
  accent: string
  /** CSS font-family 列表；空字符串表示使用内置的 Segoe UI Variable。 */
  fontFamily: string
  fontScale: UiFontScale
  /** 用户自定义 CSS，追加在所有内置样式之后。 */
  customCss: string
  /** 自定义 CSS 的总开关；关闭后保留内容但不生效。 */
  customCssEnabled: boolean
}

export const DEFAULT_UI_STYLE: Readonly<UiStyle> = Object.freeze({
  accent: '',
  fontFamily: '',
  fontScale: 'default',
  customCss: '',
  customCssEnabled: false
})

export const UI_STYLE_FILE = 'ui-style.json'
/** 自定义 CSS 的长度上限（字符）。 */
export const MAX_CUSTOM_CSS_LENGTH = 64 * 1024
export const MAX_FONT_FAMILY_LENGTH = 200

export const UI_FONT_SCALES: Readonly<Record<UiFontScale, number>> = Object.freeze({
  small: 0.93,
  default: 1,
  large: 1.07,
  larger: 1.14
})

/** 与 tokens.css 中 `--font-size-*` 的基准值一致。 */
export const BASE_FONT_SIZES: Readonly<Record<string, number>> = Object.freeze({
  '2xs': 10,
  xs: 11,
  sm: 12,
  md: 13,
  body: 14,
  lg: 15,
  xl: 16,
  title: 20,
  '2xl': 24,
  display: 28,
  hero: 34
})

/** 预设强调色，取自 Windows / macOS 的系统强调色。 */
export const ACCENT_PRESETS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: '', label: '默认蓝' },
  { value: '#8e5af7', label: '紫色' },
  { value: '#e5508f', label: '粉色' },
  { value: '#e0443e', label: '红色' },
  { value: '#f2862e', label: '橙色' },
  { value: '#e8b21c', label: '黄色' },
  { value: '#3fb34f', label: '绿色' },
  { value: '#8c8c91', label: '石墨' }
])

/** 字体输入框的候选项，都是 Windows 自带或常见的字体。 */
export const FONT_SUGGESTIONS: readonly string[] = Object.freeze([
  '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  '"HarmonyOS Sans SC", sans-serif',
  '"MiSans", sans-serif',
  '"Inter", "Segoe UI", sans-serif',
  '"Noto Sans SC", sans-serif',
  '"Cascadia Code", Consolas, monospace'
])

/**
 * 可以在自定义 CSS 里覆盖的变量。名字是稳定接口：重命名或删除前要在更新日志里说明。
 */
export const UI_STYLE_VARIABLES: ReadonlyArray<{ name: string; detail: string }> = Object.freeze([
  { name: '--app-font', detail: '全局字体' },
  { name: '--app-accent', detail: '强调色（按钮、开关、选中项）' },
  { name: '--app-on-accent', detail: '强调色上的文字颜色' },
  { name: '--app-text', detail: '正文文字' },
  { name: '--app-muted', detail: '次要文字' },
  { name: '--app-pink', detail: '页面小标题' },
  { name: '--app-danger', detail: '错误、危险操作' },
  { name: '--app-warning', detail: '警告' },
  { name: '--app-background-start', detail: '窗口渐变背景起点' },
  { name: '--app-background-end', detail: '窗口渐变背景终点' },
  { name: '--content-panel', detail: '右侧内容面板底色' },
  { name: '--app-surface', detail: '卡片底色' },
  { name: '--app-divider', detail: '分隔线' },
  { name: '--app-sidebar-selected', detail: '侧边栏选中项' },
  { name: '--glass-bg', detail: '右键菜单、弹窗的玻璃底色' },
  { name: '--radius-card', detail: '卡片圆角' },
  { name: '--radius-control', detail: '按钮、输入框圆角' },
  { name: '--font-size-body', detail: '正文字号（其余 --font-size-* 同理）' }
])

const HEX_COLOR = /^#[0-9a-f]{6}$/

export function normalizeAccent(value: unknown): string {
  if (typeof value !== 'string') return ''
  let text = value.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(text)) text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`
  return HEX_COLOR.test(text) ? text : ''
}

/**
 * font-family 只接受字体名、引号、逗号、空格和连字符，拒绝任何能结束声明或引入
 * 新规则的字符（`;{}<>\` 与 `url(`），因此它不能被用来注入额外的 CSS。
 */
export function normalizeFontFamily(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim().replace(/\s+/g, ' ')
  if (!text || text.length > MAX_FONT_FAMILY_LENGTH) return ''
  if (/[;{}<>\\]/.test(text) || /url\s*\(/i.test(text)) return ''
  const doubleQuotes = text.split('"').length - 1
  const singleQuotes = text.split("'").length - 1
  if (doubleQuotes % 2 !== 0 || singleQuotes % 2 !== 0) return ''
  return text
}

export function normalizeFontScale(value: unknown): UiFontScale {
  return value === 'small' || value === 'large' || value === 'larger' ? value : 'default'
}

export function normalizeCustomCss(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.length > MAX_CUSTOM_CSS_LENGTH ? value.slice(0, MAX_CUSTOM_CSS_LENGTH) : value
}

/** 任意输入（磁盘 JSON、缓存、IPC 返回值）都收敛成完整的 {@link UiStyle}。 */
export function parseUiStyle(value: unknown): UiStyle {
  let source = value
  if (typeof source === 'string') {
    try { source = JSON.parse(source) } catch { return { ...DEFAULT_UI_STYLE } }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { ...DEFAULT_UI_STYLE }
  const record = source as Record<string, unknown>
  return {
    accent: normalizeAccent(record.accent),
    fontFamily: normalizeFontFamily(record.fontFamily),
    fontScale: normalizeFontScale(record.fontScale),
    customCss: normalizeCustomCss(record.customCss),
    customCssEnabled: record.customCssEnabled === true
  }
}

export function isDefaultUiStyle(style: UiStyle): boolean {
  return style.accent === '' && style.fontFamily === '' && style.fontScale === 'default' && style.customCss === '' && !style.customCssEnabled
}

/**
 * 强调色上用白字还是黑字。和系统强调色的习惯一致：白字只要达到 3:1（WCAG 对按钮、
 * 大字的要求）就用白字，只有黄色、浅灰这类很亮的颜色才换成黑字。
 */
export function onAccentColor(accent: string): '#ffffff' | '#000000' {
  const hex = normalizeAccent(accent)
  if (!hex) return '#ffffff'
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  return 1.05 / (luminance + 0.05) >= 3 ? '#ffffff' : '#000000'
}

/**
 * 字体、强调色、字号对应的变量覆盖。只输出与默认值不同的项，默认样式下返回空串，
 * 不改变任何内置规则。
 */
export function uiStyleVariablesCss(style: UiStyle): string {
  const declarations: string[] = []
  if (style.fontFamily) declarations.push(`--app-font: ${style.fontFamily};`)
  if (style.accent) {
    // 组件大多直接引用 --app-blue 作为强调色，两者一起覆盖。
    declarations.push(`--app-blue: ${style.accent};`, `--app-accent: ${style.accent};`, `--app-on-accent: ${onAccentColor(style.accent)};`)
  }
  const scale = UI_FONT_SCALES[style.fontScale]
  if (scale !== 1) {
    for (const [name, size] of Object.entries(BASE_FONT_SIZES)) {
      declarations.push(`--font-size-${name}: ${Math.round(size * scale * 2) / 2}px;`)
    }
  }
  if (!declarations.length) return ''
  // 样式表追加在 head 末尾；html:root 再多一档特异性，压过 tokens.css 里的 :root。
  return `html:root {\n  ${declarations.join('\n  ')}\n}\n`
}
