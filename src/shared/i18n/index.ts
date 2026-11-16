/**
 * Interface language. Messages live in `locales/<locale>.json` as flat
 * `namespace.name` keys; `zh-CN` is the source language and every other
 * locale must carry exactly the same keys (tests/i18n.test.ts).
 *
 * `t()` reads a reactive ref, so templates and computeds follow a language
 * switch without a restart.
 */
import { ref } from 'vue'
import zhCN from './locales/zh-CN.json'
import en from './locales/en.json'

export type Locale = 'zh-CN' | 'en'
/** The persisted preference (`AppSettings.language`). */
export type LanguageSetting = 'system' | Locale
export type MessageKey = keyof typeof zhCN
export type MessageParams = readonly unknown[] | Readonly<Record<string, unknown>>

export const LOCALES: readonly Locale[] = ['zh-CN', 'en']
export const DEFAULT_LOCALE: Locale = 'zh-CN'
/** Each language under its own name, as language pickers list them. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { 'zh-CN': '简体中文', en: 'English' }

const MESSAGES: Record<Locale, Record<string, string>> = { 'zh-CN': zhCN, en }
const STORAGE_KEY = 'app.locale'

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === 'system' || value === 'zh-CN' || value === 'en'
}

/** Map a BCP 47 tag (`zh-Hans-CN`, `en-GB`) to a shipped locale. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  const lower = (tag ?? '').trim().toLowerCase()
  if (!lower) return null
  if (lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_')) return 'zh-CN'
  if (lower === 'en' || lower.startsWith('en-') || lower.startsWith('en_')) return 'en'
  return null
}

/**
 * "跟随系统": the first system language we ship; any other language gets
 * English, the more widely read of the two.
 */
export function systemLocale(languages?: readonly string[]): Locale {
  // Only a real window knows the user's languages (Node's `navigator` reports the build machine's).
  const list = languages ?? (typeof window === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language])
  for (const tag of list) {
    const match = matchLocale(tag)
    if (match) return match
  }
  return list.length > 0 ? 'en' : DEFAULT_LOCALE
}

export function resolveLocale(setting: LanguageSetting, languages?: readonly string[]): Locale {
  return setting === 'system' ? systemLocale(languages) : setting
}

function storedLocale(): Locale | null {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY)
    return value === 'zh-CN' || value === 'en' ? value : null
  } catch {
    return null
  }
}

/**
 * The language in effect. Starts from the last one this machine used (kept in
 * localStorage so the first paint is already right) or, on a first launch,
 * the system language; then follows the app setting once it is read.
 */
export const locale = ref<Locale>(storedLocale() ?? systemLocale())

export function setLocale(next: Locale): void {
  locale.value = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next)
  } catch { /* private mode / tests: the setting still applies in memory */ }
  if (typeof document !== 'undefined') document.documentElement.lang = next
}

/** Apply the persisted preference. */
export function applyLanguageSetting(setting: unknown): void {
  setLocale(resolveLocale(isLanguageSetting(setting) ? setting : 'system'))
}

/** Follow a language change made in another window (main window ↔ tray popup). */
export function followStoredLocale(): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY) return
    const next = storedLocale()
    if (next && next !== locale.value) setLocale(next)
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

export function format(template: string, params?: MessageParams): string {
  if (!params) return template
  const values = params as Record<string, unknown>
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name] ?? '') : match))
}

/** Message for `key` in `target` (falling back to the source language). */
export function translate(target: Locale, key: MessageKey, params?: MessageParams): string {
  return format(MESSAGES[target][key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key, params)
}

/** Message for `key` in the current language; `{0}` / `{name}` are filled from `params`. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(locale.value, key, params)
}
