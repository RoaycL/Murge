import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM release script without type declarations
import { compareVersions, feedsFor, isPrerelease } from '../scripts/release-feeds.mjs'

describe('release feeds', () => {
  it('orders versions by SemVer precedence', () => {
    expect(compareVersions('1.0.0', '0.9.37')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(() => compareVersions('1.0', '1.0.0')).toThrow()
    expect(() => compareVersions('1.0.0+build', '1.0.0')).toThrow()
  })

  it('tells Beta from 正式版', () => {
    expect(isPrerelease('1.0.0-beta.1')).toBe(true)
    expect(isPrerelease('1.0.0')).toBe(false)
    expect(() => isPrerelease('one')).toThrow()
  })

  it('keeps a Beta off every stable feed', () => {
    expect(feedsFor('1.1.0-beta.1', '1.0.0')).toEqual(['update-beta'])
    expect(feedsFor('1.1.0-beta.1')).toEqual(['update-beta'])
  })

  it('moves 正式版 to the stable feeds and to the beta feed unless a newer Beta is there', () => {
    expect(feedsFor('1.0.0')).toEqual(['update-stable', 'update-beta', 'channel-experimental'])
    expect(feedsFor('1.0.1', '1.0.0')).toEqual(['update-stable', 'update-beta', 'channel-experimental'])
    expect(feedsFor('1.1.0', '1.1.0-beta.3')).toEqual(['update-stable', 'update-beta', 'channel-experimental'])
    expect(feedsFor('1.0.1', '1.1.0-beta.1')).toEqual(['update-stable', 'channel-experimental'])
  })
})
