import { describe, expect, it } from 'vitest'
import { moduleSection, replaceModuleSection } from '../src/shared/mitm'

const TEXT = `#!name=Local
[MITM]
hostname = %APPEND% a.com

[URL Rewrite]
^https://a\\.com/x - reject

[Map Local]
^https://a\\.com/ads data="{}"
[url rewrite]
^https://a\\.com/y https://b.com 302
`

describe('module sections', () => {
  it('reads every occurrence of a section, case-insensitively', () => {
    expect(moduleSection(TEXT, 'URL Rewrite')).toBe('^https://a\\.com/x - reject\n^https://a\\.com/y https://b.com 302')
    expect(moduleSection(TEXT, 'Script')).toBe('')
  })

  it('replaces in place, drops duplicates and keeps other sections', () => {
    const next = replaceModuleSection(TEXT, 'URL Rewrite', '^https://c\\.com - reject\n')
    expect(next).toBe(`#!name=Local
[MITM]
hostname = %APPEND% a.com

[URL Rewrite]
^https://c\\.com - reject

[Map Local]
^https://a\\.com/ads data="{}"
`)
    expect(moduleSection(next, 'Map Local')).toBe('^https://a\\.com/ads data="{}"')
  })

  it('appends a missing section and removes an emptied one', () => {
    const added = replaceModuleSection(TEXT, 'Script', 'demo = type=http-request,pattern=^https://a\\.com,script-path=a.js')
    expect(added.endsWith('[Script]\ndemo = type=http-request,pattern=^https://a\\.com,script-path=a.js\n')).toBe(true)
    expect(replaceModuleSection('', 'Rule', 'DOMAIN,a.com,REJECT')).toBe('[Rule]\nDOMAIN,a.com,REJECT\n')
    const removed = replaceModuleSection(TEXT, 'Map Local', '')
    expect(removed).not.toContain('[Map Local]')
    expect(moduleSection(removed, 'URL Rewrite')).toContain('b.com')
    expect(replaceModuleSection('[Rule]\nDOMAIN,a.com,REJECT\n', 'Rule', '')).toBe('')
  })
})
