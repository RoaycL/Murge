import { afterEach, describe, expect, it } from 'vitest'
import {
  approveNavigation, cancelNavigation, clearUnsavedChange, consumeNavigationBypass,
  hasUnsavedChanges, pendingNavigation, requestNavigation, setUnsavedChange, unsavedLabels
} from '../src/renderer/src/composables/use-unsaved-changes'

describe('unsaved change navigation gate', () => {
  afterEach(() => {
    clearUnsavedChange('test-a')
    clearUnsavedChange('test-b')
    cancelNavigation()
  })

  it('collects dirty sections and allows exactly one approved navigation', () => {
    setUnsavedChange('test-a', 'DNS 设置')
    setUnsavedChange('test-b', 'TUN 配置')
    expect(hasUnsavedChanges.value).toBe(true)
    expect(unsavedLabels.value).toEqual(['DNS 设置', 'TUN 配置'])

    requestNavigation('/activity')
    expect(pendingNavigation.value).toBe('/activity')
    expect(approveNavigation()).toBe('/activity')
    expect(consumeNavigationBypass('/activity')).toBe(true)
    expect(consumeNavigationBypass('/activity')).toBe(false)
  })

  it('cancels a pending navigation without clearing dirty forms', () => {
    setUnsavedChange('test-a', '内核设置')
    requestNavigation('/rules')
    cancelNavigation()
    expect(pendingNavigation.value).toBeNull()
    expect(hasUnsavedChanges.value).toBe(true)
  })
})
