import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ValidationResult } from '../../shared/profiles'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { ProfileGateway } from '../../shared/gateways'
import type { ConfigValidator } from './config-validator'
import { ProfileRepository } from './profile-repository'
import type { SubscriptionFetcher } from '../subscriptions/subscription-fetcher'

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

  async importProfile(request: ImportRequest): Promise<ProfileMeta> {
    const result = this.validator.validate(request.document)
    this.throwIfInvalid(result)
    return this.repository.import(request.name, request.document, request.source, request.activate ?? false)
  }

  /**
   * Fetch a subscription config and import it. Only the redacted URL is
   * persisted, so credentials can never appear in the stored profile metadata.
   */
  async importFromUrl(name: string, url: string, activate = false): Promise<ProfileMeta> {
    const fetched = await this.fetcher.fetch(url)
    return this.importProfile({
      name,
      document: fetched.document,
      source: fetched.source,
      activate
    })
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
