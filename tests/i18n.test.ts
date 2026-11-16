import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCALE, LOCALES, LOCALE_NAMES, format, isLanguageSetting, locale, matchLocale, resolveLocale, setLocale, systemLocale, t, translate
} from '@shared/i18n'
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '@shared/app-settings'

const root = process.cwd()
const readJson = (path: string): Record<string, string> => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<string, string>
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === 'locales' ? [] : sourceFiles(path)
    return /\.(vue|ts)$/.test(name) ? [path] : []
  })
}

/** Drop comments so only text that can reach the screen is left. */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

afterEach(() => setLocale(DEFAULT_LOCALE))

describe.each([
  ['renderer', 'src/shared/i18n/locales'],
  ['shell', 'src-tauri/locales']
])('%s locale files', (_name, directory) => {
  const source = readJson(`${directory}/zh-CN.json`)

  it.each(LOCALES.filter((name) => name !== 'zh-CN'))('%s carries exactly the zh-CN keys', (name) => {
    expect(Object.keys(readJson(`${directory}/${name}.json`)).sort()).toEqual(Object.keys(source).sort())
  })

  it.each(LOCALES.filter((name) => name !== 'zh-CN'))('%s keeps every placeholder and leaves nothing empty or untranslated', (name) => {
    const target = readJson(`${directory}/${name}.json`)
    for (const [key, text] of Object.entries(source)) {
      expect(placeholders(target[key]), key).toEqual(placeholders(text))
      expect(target[key].trim() !== '' || text.trim() === '', key).toBe(true)
      expect(target[key], key).not.toMatch(/\p{Script=Han}/u)
    }
  })

  it('names keys namespace.name', () => {
    for (const key of Object.keys(source)) expect(key).toMatch(/^[a-z][\w]*(\.[A-Za-z0-9]+)+$/)
  })
})

describe('message lookup', () => {
  it('translates into the language in effect and fills parameters', () => {
    expect(t('common.save')).toBe('保存')
    setLocale('en')
    expect(locale.value).toBe('en')
    expect(t('common.save')).toBe('Save')
    expect(t('profiles.lineError', [3, 'bad'])).toBe('Line 3: bad')
    expect(translate('zh-CN', 'profiles.lineError', [3, 'bad'])).toBe('第 3 行：bad')
    expect(format('{name} {0} {missing}', { name: 'a', 0: 'b' })).toBe('a b {missing}')
  })

  it('resolves the persisted setting against the system languages', () => {
    expect(matchLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(matchLocale('zh_TW')).toBe('zh-CN')
    expect(matchLocale('en-GB')).toBe('en')
    expect(matchLocale('ja')).toBeNull()
    expect(systemLocale(['ja-JP', 'zh-CN'])).toBe('zh-CN')
    expect(systemLocale(['ja-JP'])).toBe('en')
    expect(systemLocale([])).toBe('zh-CN')
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('system', ['en-US'])).toBe('en')
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...LOCALES].sort())
  })

  it('persists the language as an app setting, defaulting to the system language', () => {
    expect(DEFAULT_APP_SETTINGS.language).toBe('system')
    expect(parseAppSettings('{"language":"en"}').language).toBe('en')
    expect(parseAppSettings('{"language":"fr"}').language).toBe('system')
    expect(isLanguageSetting('zh-CN')).toBe(true)
    expect(isLanguageSetting('zh')).toBe(false)
  })
})

describe('renderer source', () => {
  const files = [...sourceFiles(resolve(root, 'src/renderer/src')), ...sourceFiles(resolve(root, 'src/shared'))]
  const messages = readJson('src/shared/i18n/locales/zh-CN.json')

  // Text that is data rather than interface copy.
  const allowed: Record<string, RegExp[]> = {
    'src/shared/i18n/index.ts': [/'简体中文'/],
    // Usage-history bucket names persisted by the shell.
    'src/shared/process-usage.ts': [/'其他进程'/, /'未知进程'/]
  }

  it('keeps interface text in the locale files', () => {
    const offenders: string[] = []
    for (const file of files) {
      const relative = file.slice(root.length + 1).replaceAll('\\', '/')
      const [body] = readFileSync(file, 'utf8').split(/<style[\s>]/)
      stripComments(body).split('\n').forEach((line) => {
        const rest = (allowed[relative] ?? []).reduce((text, pattern) => text.replace(pattern, ''), line)
        if (/\p{Script=Han}/u.test(rest)) offenders.push(`${relative}: ${line.trim().slice(0, 80)}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('only asks for keys that exist, and uses every key', () => {
    const used = new Set<string>()
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(?<![\w.$])t\('([^']+)'/g)) used.add(match[1])
    }
    expect([...used].filter((key) => !(key in messages))).toEqual([])
    expect(Object.keys(messages).filter((key) => !used.has(key))).toEqual([])
  })
})
