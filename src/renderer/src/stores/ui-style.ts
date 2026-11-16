import { computed, ref, watchEffect } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_UI_STYLE, isDefaultUiStyle, normalizeCustomCss, parseUiStyle, uiStyleVariablesCss, type UiStyle } from '@shared/ui-style'
import { t } from '@shared/i18n'
import { useToast } from '../composables/use-toast'

/** 渲染进程缓存：只用来在 IPC 返回前就套上样式，避免启动时闪一下默认外观。 */
export const UI_STYLE_CACHE_KEY = 'ui-style.v1'
/** 应用新的自定义 CSS 后，多少秒内没点「保留」就自动还原。 */
export const TRIAL_SECONDS = 15
/** 随时停用自定义 CSS 的快捷键（只影响本次运行，不改保存的内容）。 */
export const SAFE_MODE_SHORTCUT = 'Ctrl+Alt+Shift+C'

export const VARIABLES_STYLE_ID = 'ui-style-variables'
export const CUSTOM_STYLE_ID = 'ui-style-custom'
export const GUARD_STYLE_ID = 'ui-style-guard'

/**
 * 试用期间追加在用户 CSS 之后的保护规则：同等特异性下后者胜出，确保即使用户 CSS 把
 * 整页藏掉，确认条也还看得见、点得到。真被盖住了也没关系，倒计时结束会自动还原。
 */
export const TRIAL_GUARD_CSS = `html, body { display: block !important; visibility: visible !important; opacity: 1 !important; }
#ui-style-trial-bar { display: flex !important; visibility: visible !important; opacity: 1 !important; position: fixed !important; z-index: 2147483647 !important; pointer-events: auto !important; }
#ui-style-trial-bar * { visibility: visible !important; pointer-events: auto !important; }
`

export function isSafeModeShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code'>): boolean {
  return event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey && event.code === 'KeyC'
}

/** 当前真正生效的自定义 CSS：试用中的优先，其次是已保存且开启的，安全模式下一律为空。 */
export function effectiveCustomCss(saved: UiStyle, trialCss: string | null, suspended: boolean): string {
  if (suspended) return ''
  if (trialCss !== null) return trialCss
  return saved.customCssEnabled ? saved.customCss : ''
}

function readCache(): UiStyle {
  try { return parseUiStyle(window.localStorage.getItem(UI_STYLE_CACHE_KEY)) } catch { return { ...DEFAULT_UI_STYLE } }
}

function writeCache(style: UiStyle): void {
  try {
    if (isDefaultUiStyle(style)) window.localStorage.removeItem(UI_STYLE_CACHE_KEY)
    else window.localStorage.setItem(UI_STYLE_CACHE_KEY, JSON.stringify(style))
  } catch { /* 缓存失败只影响启动时的第一帧 */ }
}

/** Finds or creates the <style> at the end of head so it comes after every built-in style. */
function styleElement(id: string): HTMLStyleElement {
  let element = document.getElementById(id) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = id
  }
  if (element.parentNode !== document.head || element.nextElementSibling) document.head.appendChild(element)
  return element
}

function setStyle(id: string, css: string): void {
  if (!css) { document.getElementById(id)?.remove(); return }
  const element = styleElement(id)
  if (element.textContent !== css) element.textContent = css
}

export const useUiStyleStore = defineStore('ui-style', () => {
  const toast = useToast()
  const saved = ref<UiStyle>(readCache())
  const suspended = ref(false)
  const trialCss = ref<string | null>(null)
  const trialRemaining = ref(0)
  const saving = ref(false)
  let trialTimer: ReturnType<typeof setInterval> | null = null
  let connected = false

  const activeCustomCss = computed(() => effectiveCustomCss(saved.value, trialCss.value, suspended.value))
  const isDefault = computed(() => isDefaultUiStyle(saved.value))

  function render(): void {
    // 变量先写，自定义 CSS 后写，保护规则最后，顺序决定同特异性时谁胜出。
    setStyle(VARIABLES_STYLE_ID, uiStyleVariablesCss(saved.value))
    setStyle(CUSTOM_STYLE_ID, activeCustomCss.value)
    setStyle(GUARD_STYLE_ID, trialCss.value !== null && !suspended.value ? TRIAL_GUARD_CSS : '')
  }
  watchEffect(render)

  async function persist(patch: Partial<UiStyle>): Promise<boolean> {
    const previous = saved.value
    saved.value = parseUiStyle({ ...saved.value, ...patch })
    writeCache(saved.value)
    saving.value = true
    try {
      saved.value = parseUiStyle(await window.desktop.uiStyle.set(patch))
      writeCache(saved.value)
      return true
    } catch (error) {
      saved.value = previous
      writeCache(previous)
      toast.error(t('uiStyle.toastNotSaved'), error instanceof Error ? error.message : String(error))
      return false
    } finally {
      saving.value = false
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (isSafeModeShortcut(event)) {
      event.preventDefault()
      toggleSuspended()
    } else if (event.key === 'Escape' && trialCss.value !== null) {
      revertTrial()
    }
  }

  async function connect(): Promise<void> {
    if (connected) return
    connected = true
    window.addEventListener('keydown', onKeydown, true)
    try {
      saved.value = parseUiStyle(await window.desktop.uiStyle.get())
      writeCache(saved.value)
    } catch { /* 读不到时沿用缓存 */ }
  }

  function disconnect(): void {
    connected = false
    window.removeEventListener('keydown', onKeydown, true)
    stopTimer()
  }

  function stopTimer(): void {
    if (trialTimer) clearInterval(trialTimer)
    trialTimer = null
  }

  /** 先试用：立刻生效，倒计时内点「保留」才保存，否则还原。 */
  function tryCustomCss(css: string): void {
    stopTimer()
    suspended.value = false
    trialCss.value = normalizeCustomCss(css)
    trialRemaining.value = TRIAL_SECONDS
    trialTimer = setInterval(() => {
      trialRemaining.value -= 1
      if (trialRemaining.value <= 0) {
        revertTrial()
        toast.info(t('uiStyle.toastReverted'), t('uiStyle.toastRevertedDetail'))
      }
    }, 1000)
  }

  async function keepTrial(): Promise<void> {
    const css = trialCss.value
    if (css === null) return
    stopTimer()
    trialCss.value = null
    if (await persist({ customCss: css, customCssEnabled: true })) toast.success(t('uiStyle.toastSaved'))
  }

  function revertTrial(): void {
    stopTimer()
    trialCss.value = null
    trialRemaining.value = 0
  }

  function toggleSuspended(): void {
    suspended.value = !suspended.value
    if (suspended.value) {
      revertTrial()
      toast.info(t('uiStyle.toastSuspended'), t('uiStyle.toastSuspendedDetail', [SAFE_MODE_SHORTCUT]))
    } else {
      toast.info(t('uiStyle.toastResumed'))
    }
  }

  function setCustomCssEnabled(enabled: boolean): void {
    // 关闭总是安全的，直接保存；重新打开要走一遍试用，防止旧 CSS 把界面弄坏。
    if (!enabled) { revertTrial(); void persist({ customCssEnabled: false }); return }
    // 还没写过 CSS 时没什么可试用的，直接打开，编辑框随之出现。
    if (!saved.value.customCss.trim()) { void persist({ customCssEnabled: true }); return }
    tryCustomCss(saved.value.customCss)
  }

  const setAccent = (accent: string) => persist({ accent })
  const setFontFamily = (fontFamily: string) => persist({ fontFamily })
  const setFontScale = (fontScale: UiStyle['fontScale']) => persist({ fontScale })

  async function resetAll(): Promise<void> {
    revertTrial()
    suspended.value = false
    if (await persist({ ...DEFAULT_UI_STYLE })) toast.success(t('uiStyle.toastReset'))
  }

  return {
    saved, suspended, trialCss, trialRemaining, saving, activeCustomCss, isDefault,
    connect, disconnect, tryCustomCss, keepTrial, revertTrial, toggleSuspended,
    setCustomCssEnabled, setAccent, setFontFamily, setFontScale, resetAll
  }
})
