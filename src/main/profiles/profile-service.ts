import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ProfileSubscription, ValidationResult } from '../../shared/profiles'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { ProfileGateway } from '../../shared/gateways'
import type { ConfigValidator } from './config-validator'
import { ProfileRepository } from './profile-repository'
import type { SubscriptionFetcher } from '../subscriptions/subscription-fetcher'
import { redactCredentials, deriveFallbackSubscriptionName } from '../subscriptions/subscription-fetcher'

/**
 * Compose the profile store, config validator, and subscription fetcher into the
 * {@link ProfileGateway}. The validator is the only gate for activation: a
 * profile is never marked active unless its document validates, so a failed
 * activation cannot move the active pointer.
 */
export class ProfileService implements ProfileGateway {
  constructor(
    private readonly repository: ProfileRepository,
    private readonly validator: ConfigValidator,
    private readonly fetcher: SubscriptionFetcher
  ) {}

  listProfiles(): Promise<ProfileMeta[]> {
    return this.repository.list()
  }

  getProfile(id: string): Promise<Profile> {
    return this.repository.get(id)
  }

  /**
   * Resolve the active profile's document for the kernel, or null when no
   * profile is active. The kernel config store calls this at start time so the
   * live mihomo controller is configured from the user's proxies/groups/rules.
   */
  getActiveProfile(): Promise<Profile | null> {
    return this.repository.getActive()
  }

  async importProfile(request: ImportRequest): Promise<ProfileMeta> {
    const result = this.validator.validate(request.document)
    this.throwIfInvalid(result)
    
    // Ensure URL is redacted before persisting
    const processedSource: ProfileSubscription = {
      ...request.source,
      url: request.source.url ? redactCredentials(request.source.url) : undefined
    }
    
    return this.repository.import(request.name, request.document, processedSource, request.activate ?? false)
  }

  /**
   * Fetch a subscription config and import it. Only the redacted URL is
   * persisted, so credentials can never appear in the stored profile metadata.
   *
   * When the caller leaves the name empty, the display name is derived the way
   * community clients do: from the response's `Content-Disposition` filename,
   * falling back to the subscription host — never the raw URL, whose path can
   * carry a token (e.g. gist raw URLs) that would otherwise end up shown as a
   * profile name on the activity page.
   */
  async importFromUrl(name: string, url: string, activate = false): Promise<ProfileMeta> {
    const fetched = await this.fetcher.fetch(url)
    const trimmed = name.trim()
    const effectiveName =
      trimmed ||
      fetched.suggestedName ||
      deriveFallbackSubscriptionName(url) ||
      '远程订阅'
    return this.importProfile({
      name: effectiveName,
      document: fetched.document,
      source: fetched.source,
      activate
    })
  }

  /**
   * Re-fetch a URL-backed profile's subscription and replace its stored
   * document with the freshly validated one. The name, id and active pointer
   * are untouched; only the document, source envelope and timestamps update.
   * File/manual profiles have nothing to re-fetch and are rejected.
   */
  async updateFromSource(id: string): Promise<ProfileMeta> {
    const profile = await this.repository.get(id)
    const source = profile.meta.source
    if (source.type !== 'url' || !source.url) {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_ARGUMENT,
        '该配置没有远程订阅地址，无法更新'
      )
    }
    const fetched = await this.fetcher.fetch(source.url)
    // Validate BEFORE writing so a failed update cannot corrupt the stored doc.
    this.throwIfInvalid(this.validator.validate(fetched.document))
    return this.repository.replaceFromSource(id, fetched.document, fetched.source)
  }

  async activateProfile(id: string): Promise<ProfileMeta> {
    const profile = await this.repository.get(id)
    const result = this.validator.validate(profile.document)
    this.throwIfInvalid(result)
    const previousActive = (await this.repository.list()).find((meta) => meta.active)?.id ?? null
    try {
      return await this.repository.activate(id)
    } catch (error) {
      // Atomic pointer writes leave either the old or new state intact. If the
      // write did fail, restore the prior active profile so the app never points
      // at a half-activated profile, then propagate the original failure.
      await this.restoreActive(previousActive)
      throw error
    }
  }

  /** Used by the auto-reload coordinator to compensate a failed first activation. */
  deactivateProfile(): Promise<void> {
    return this.repository.deactivate()
  }

  async restoreProfileDocument(id: string, document: string): Promise<void> {
    this.throwIfInvalid(this.validator.validate(document))
    await this.repository.restoreDocument(id, document)
  }

  deleteProfile(id: string): Promise<void> {
    return this.repository.delete(id)
  }

  renameProfile(id: string, name: string): Promise<ProfileMeta> {
    return this.repository.rename(id, name)
  }

  async editDocument(id: string, edits: ConfigEdit[]): Promise<ProfileMeta> {
    // Validate the WOULD-BE document before writing so a rejected edit cannot
    // leave a half-edited (invalid) document on disk.
    const nextDocument = await this.repository.previewEdit(id, edits)
    this.throwIfInvalid(this.validator.validate(nextDocument))
    return this.repository.editDocument(id, edits)
  }

  validateDocument(document: string): ValidationResult {
    return this.validator.validate(document)
  }

  private async restoreActive(previousActive: string | null): Promise<void> {
    if (previousActive) {
      try {
        await this.repository.activate(previousActive)
      } catch {
        // Best-effort: the pointer is unchanged on a failed atomic write anyway.
      }
    }
  }

  private throwIfInvalid(result: ValidationResult): void {
    if (!result.ok) {
      const detail = result.issues.map((issue) => issue.message).join('；')
      throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, `配置校验失败：${detail}`)
    }
  }
}
