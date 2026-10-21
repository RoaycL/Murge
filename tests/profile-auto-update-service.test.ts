import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileMeta } from '../src/shared/profiles'
import { ProtocolError, ProtocolErrorCode } from '../src/shared/protocol-errors'
import {
  ProfileAutoUpdateService,
  PROFILE_AUTO_UPDATE_INTERVAL_MS,
  PROFILE_AUTO_UPDATE_RETRY_MS
} from '../src/main/profiles/profile-auto-update-service'

function profile(id: string, type: 'url' | 'file' | 'manual', active = false): ProfileMeta {
  return {
    id,
    name: id,
    source: type === 'url' ? { type, url: `https://example.com/${id}` } : { type },
    size: 1,
    createdAt: 0,
    updatedAt: 0,
    active
  }
}

afterEach(() => vi.useRealTimers())

describe('ProfileAutoUpdateService', () => {
  it('updates only remote profiles after launch and every 72 hours, active first', async () => {
    vi.useFakeTimers()
    const listProfiles = vi.fn(async () => [
      profile('inactive', 'url'), profile('file', 'file'),
      profile('active', 'url', true), profile('manual', 'manual')
    ])
    const updateFromSource = vi.fn(async (id: string) => profile(id, 'url'))
    const updater = new ProfileAutoUpdateService({ listProfiles, updateFromSource })

    updater.start()
    await updater.waitForIdle()
    expect(updateFromSource.mock.calls.map(([id]) => id)).toEqual(['active', 'inactive'])

    await vi.advanceTimersByTimeAsync(PROFILE_AUTO_UPDATE_INTERVAL_MS)
    await updater.waitForIdle()
    expect(updateFromSource.mock.calls.map(([id]) => id)).toEqual([
      'active', 'inactive', 'active', 'inactive'
    ])

    updater.stop()
    await vi.advanceTimersByTimeAsync(PROFILE_AUTO_UPDATE_INTERVAL_MS)
    expect(updateFromSource).toHaveBeenCalledTimes(4)
  })

  it('retries a transport failure without re-fetching successful profiles', async () => {
    vi.useFakeTimers()
    const listProfiles = vi.fn(async () => [profile('active', 'url', true), profile('other', 'url')])
    const updateFromSource = vi.fn(async (id: string) => {
      if (id === 'active' && updateFromSource.mock.calls.filter(([value]) => value === id).length === 1) {
        throw new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'offline')
      }
      return profile(id, 'url')
    })
    const updater = new ProfileAutoUpdateService({ listProfiles, updateFromSource })

    updater.start()
    await updater.waitForIdle()
    expect(updateFromSource.mock.calls.map(([id]) => id)).toEqual(['active', 'other'])

    await vi.advanceTimersByTimeAsync(PROFILE_AUTO_UPDATE_RETRY_MS)
    await updater.waitForIdle()
    expect(updateFromSource.mock.calls.map(([id]) => id)).toEqual(['active', 'other', 'active'])

    await vi.advanceTimersByTimeAsync(PROFILE_AUTO_UPDATE_RETRY_MS)
    expect(updateFromSource).toHaveBeenCalledTimes(3)
    updater.stop()
  })

  it('retries transport failures immediately after network recovery', async () => {
    vi.useFakeTimers()
    const updateFromSource = vi.fn()
      .mockRejectedValueOnce(new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'offline'))
      .mockResolvedValue(profile('remote', 'url'))
    const updater = new ProfileAutoUpdateService({
      listProfiles: async () => [profile('remote', 'url')], updateFromSource
    })

    updater.start()
    await updater.waitForIdle()
    updater.retryFailed()
    await updater.waitForIdle()
    expect(updateFromSource).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(PROFILE_AUTO_UPDATE_RETRY_MS)
    expect(updateFromSource).toHaveBeenCalledTimes(2)
    updater.stop()
  })

  it('keeps validation failures for the next 72-hour check, without rapid retries', async () => {
    vi.useFakeTimers()
    const updateFromSource = vi.fn(async () => {
      throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'invalid YAML')
    })
    const updater = new ProfileAutoUpdateService({
      listProfiles: async () => [profile('remote', 'url')], updateFromSource
    })

    updater.start()
    await updater.waitForIdle()
    await vi.advanceTimersByTimeAsync(PROFILE_AUTO_UPDATE_RETRY_MS)
    expect(updateFromSource).toHaveBeenCalledTimes(1)
    updater.stop()
  })
})
