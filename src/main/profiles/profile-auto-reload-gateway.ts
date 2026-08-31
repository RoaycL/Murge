import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ValidationResult } from '../../shared/profiles'
import type { ProfileGateway } from '../../shared/gateways'

/**
 * Reapplies an already-mutated profile to the live kernel. Implementations decide
 * whether the kernel is running and whether to restart it; the gateway only owns
 * the profile-side sequencing (auto-activate + when to call this).
 */
export interface ProfileReloader {
  reload(): Promise<void>
}

export interface ProfileAutoReloadGatewayOptions {
  /** The real profile service this wrapper decorates. */
  inner: ProfileGateway
  /** Reapplies the (now active) profile to the live kernel. */
  reloader: ProfileReloader
  /**
   * When true, saving an edit to a profile that is not currently active first
   * activates that profile, so the just-edited document becomes the live one
   * before the kernel reloads.
   */
  autoActivateOnEdit: boolean
}

/**
 * Decorates a {@link ProfileGateway} so that mutating the active config takes
 * effect immediately:
 *  - editing a profile (re)applies it;
 *  - editing a non-active profile (optionally) activates it first;
 *  - activating a profile applies it;
 *  - importing a profile with `activate: true` applies it.
 *
 * Delegation keeps every non-mutating method untouched; the reloader is invoked
 * only after the underlying mutation has fully settled so the kernel always
 * observes a committed active-pointer change.
 */
export class ProfileAutoReloadGateway implements ProfileGateway {
  private readonly inner: ProfileGateway
  private readonly reloader: ProfileReloader
  private readonly autoActivateOnEdit: boolean

  constructor(options: ProfileAutoReloadGatewayOptions) {
    this.inner = options.inner
    this.reloader = options.reloader
    this.autoActivateOnEdit = options.autoActivateOnEdit
  }

  listProfiles(): ProfileMeta[] | Promise<ProfileMeta[]> {
    return this.inner.listProfiles()
  }

  getProfile(id: string): Profile | Promise<Profile> {
    return this.inner.getProfile(id)
  }

  async importProfile(request: ImportRequest): Promise<ProfileMeta> {
    const meta = await this.inner.importProfile(request)
    if (request.activate) await this.reloader.reload()
    return meta
  }

  async importFromUrl(name: string, url: string, activate = false): Promise<ProfileMeta> {
    const meta = await this.inner.importFromUrl(name, url, activate)
    if (activate) await this.reloader.reload()
    return meta
  }

  async activateProfile(id: string): Promise<ProfileMeta> {
    const meta = await this.inner.activateProfile(id)
    await this.reloader.reload()
    return meta
  }

  deleteProfile(id: string): Promise<void> {
    return this.inner.deleteProfile(id)
  }

  renameProfile(id: string, name: string): ProfileMeta | Promise<ProfileMeta> {
    return this.inner.renameProfile(id, name)
  }

  async editDocument(id: string, edits: ConfigEdit[]): Promise<ProfileMeta> {
    const meta = await this.inner.editDocument(id, edits)
    const activeId = await this.currentActiveId()
    if (activeId === id) {
      // Editing the live profile: reapply it as-is.
      await this.reloader.reload()
      return meta
    }
    if (this.autoActivateOnEdit) {
      // Save-as-apply: the edited profile becomes active before the reload.
      const activated = await this.inner.activateProfile(id)
      await this.reloader.reload()
      return activated
    }
    return meta
  }

  validateDocument(document: string): ValidationResult | Promise<ValidationResult> {
    return this.inner.validateDocument(document)
  }

  private async currentActiveId(): Promise<string | null> {
    const metas = await this.inner.listProfiles()
    return metas.find((meta) => meta.active)?.id ?? null
  }
}
