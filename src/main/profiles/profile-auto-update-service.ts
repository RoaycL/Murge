import type { ProfileGateway } from '../../shared/gateways'
import { isTransportFailure } from '../subscriptions/subscription-fetcher'

export const PROFILE_AUTO_UPDATE_INTERVAL_MS = 72 * 60 * 60 * 1000
export const PROFILE_AUTO_UPDATE_RETRY_MS = 15 * 60 * 1000

/** Refresh URL-backed profiles after launch and every 72 hours without delaying startup. */
export class ProfileAutoUpdateService {
  private intervalTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private readonly failedTransportIds = new Set<string>()

  constructor(
    private readonly profiles: Pick<ProfileGateway, 'listProfiles' | 'updateFromSource'>,
    private readonly shouldContinue: () => boolean = () => true,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  start(): void {
    if (this.intervalTimer) return
    this.intervalTimer = setInterval(() => { void this.run(false) }, PROFILE_AUTO_UPDATE_INTERVAL_MS)
    this.intervalTimer.unref()
    void this.run(false)
  }

  stop(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.intervalTimer = null
    this.retryTimer = null
  }

  /** A recovered connection can retry only subscriptions that failed in transit. */
  retryFailed(): void {
    if (this.failedTransportIds.size === 0 || !this.intervalTimer) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    void this.run(true)
  }

  /** Drain the current pass; also useful when shutting down or testing. */
  async waitForIdle(): Promise<void> {
    await this.inFlight
  }

  private run(retryOnly: boolean): Promise<void> {
    if (!this.intervalTimer || !this.shouldContinue()) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const task = this.update(retryOnly)
      .catch(() => this.log('[profiles] automatic update could not list profiles'))
      .finally(() => {
        if (this.inFlight === task) this.inFlight = null
      })
    this.inFlight = task
    return task
  }

  private async update(retryOnly: boolean): Promise<void> {
    const profiles = (await this.profiles.listProfiles())
      .filter((profile) => profile.source.type === 'url')
      .sort((a, b) => Number(b.active) - Number(a.active))
    const availableIds = new Set(profiles.map((profile) => profile.id))
    for (const id of this.failedTransportIds) {
      if (!availableIds.has(id)) this.failedTransportIds.delete(id)
    }

    for (const profile of profiles) {
      if (!this.intervalTimer || !this.shouldContinue()) break
      if (retryOnly && !this.failedTransportIds.has(profile.id)) continue
      try {
        await this.profiles.updateFromSource(profile.id)
        this.failedTransportIds.delete(profile.id)
        this.log(`[profiles] automatic update succeeded: ${profile.id}`)
      } catch (error) {
        if (isTransportFailure(error)) this.failedTransportIds.add(profile.id)
        else this.failedTransportIds.delete(profile.id)
        const reason = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
        this.log(`[profiles] automatic update failed: ${profile.id} (${reason})`)
      }
    }

    if (this.failedTransportIds.size === 0 && this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.failedTransportIds.size > 0 && this.intervalTimer && this.shouldContinue() && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.retryFailed()
      }, PROFILE_AUTO_UPDATE_RETRY_MS)
      this.retryTimer.unref()
    }
  }
}
