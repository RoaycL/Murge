import type { ConfigEdit, ImportRequest, Profile, ProfileMeta, ValidationResult } from '../../shared/profiles'
import type { ProfileGateway } from '../../shared/gateways'

/**
 * Reapplies an already-mutated profile to the live kernel. Implementations decide
 * whether the kernel is running and whether to restart it; the gateway only owns
 * the profile-side sequencing (auto-activate + when to call this).
 */
export interface ProfileReloader {
  /**
   * Apply the committed active profile. `rollbackActive`, when supplied, restores
   * the prior pointer if stopping or starting the replacement kernel fails.
   */
  reload(rollbackActive?: () => Promise<void>): Promise<void>
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
  /** Serialize active-pointer mutations so an older failed reload cannot undo a newer one. */
  private mutationTail: Promise<void> = Promise.resolve()

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
    return this.enqueueMutation(async () => {
      const previousActiveId = await this.currentActiveId()
      const meta = await this.inner.importProfile(request)
      if (request.activate) await this.reloadWithRollback(previousActiveId)
      return meta
    })
  }

  async importFromUrl(name: string, url: string, activate = false): Promise<ProfileMeta> {
    return this.enqueueMutation(async () => {
      const previousActiveId = await this.currentActiveId()
      const meta = await this.inner.importFromUrl(name, url, activate)
      if (activate) await this.reloadWithRollback(previousActiveId)
      return meta
    })
  }

  /**
   * Subscription update: re-fetch the document and, ONLY when the updated
   * profile is the live one, reapply it to the kernel (the user's contract:
   * updating a non-active profile must not switch or restart anything). A
   * failed reload rolls the document back to the pre-update snapshot.
   */
  async updateFromSource(id: string): Promise<ProfileMeta> {
    return this.enqueueMutation(async () => {
      const previousActiveId = await this.currentActiveId()
      const previousDocument = (await this.inner.getProfile(id)).document
      const meta = await this.inner.updateFromSource(id)
      if (previousActiveId === id) {
        await this.reloader.reload(() =>
          this.restoreEdit(previousActiveId, id, previousDocument)
        )
      }
      return meta
    })
  }

  async activateProfile(id: string): Promise<ProfileMeta> {
    return this.enqueueMutation(async () => {
      const previousActiveId = await this.currentActiveId()
      const meta = await this.inner.activateProfile(id)
      await this.reloadWithRollback(previousActiveId)
      return meta
    })
  }

  deactivateProfile(): Promise<void> {
    return this.enqueueMutation(async () => {
      const previousActiveId = await this.currentActiveId()
      await this.inner.deactivateProfile()
      if (previousActiveId !== null) await this.reloadWithRollback(previousActiveId)
    })
  }

  restoreProfileDocument(id: string, document: string): Promise<void> {
    return this.inner.restoreProfileDocument(id, document)
  }

  async deleteProfile(id: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const previousActiveId = await this.currentActiveId()
      await this.inner.deleteProfile(id)
      // The deleted document cannot be restored. Re-materialize the strict
      // fallback immediately so the process never keeps using deleted secrets.
      if (previousActiveId === id) await this.reloader.reload()
    })
  }

  renameProfile(id: string, name: string): ProfileMeta | Promise<ProfileMeta> {
    return this.inner.renameProfile(id, name)
  }

  async editDocument(id: string, edits: ConfigEdit[]): Promise<ProfileMeta> {
    return this.enqueueMutation(async () => {
      const previousActiveId = await this.currentActiveId()
      const previousDocument = (await this.inner.getProfile(id)).document
      const meta = await this.inner.editDocument(id, edits)
      if (previousActiveId === id) {
        // Editing the live profile: its pointer is already the desired one.
        await this.reloader.reload(() =>
          this.restoreEdit(previousActiveId, id, previousDocument)
        )
        return meta
      }
      if (this.autoActivateOnEdit) {
        const activated = await this.inner.activateProfile(id)
        await this.reloader.reload(() =>
          this.restoreEdit(previousActiveId, id, previousDocument)
        )
        return activated
      }
      return meta
    })
  }

  async replaceDocument(id: string, document: string): Promise<ProfileMeta> {
    return this.enqueueMutation(async () => {
      const previousActiveId = await this.currentActiveId()
      const previousDocument = (await this.inner.getProfile(id)).document
      const meta = await this.inner.replaceDocument(id, document)
      if (previousActiveId === id) await this.reloader.reload(() => this.restoreEdit(previousActiveId, id, previousDocument))
      return meta
    })
  }

  getSourceUrl(id: string): string | null | Promise<string | null> { return this.inner.getSourceUrl(id) }
  setSourceUrl(id: string, url: string): ProfileMeta | Promise<ProfileMeta> { return this.inner.setSourceUrl(id, url) }

  validateDocument(document: string): ValidationResult | Promise<ValidationResult> {
    return this.inner.validateDocument(document)
  }

  /**
   * Share the active-profile mutation boundary with operations whose meaning is
   * tied to a particular live profile (for example a controller node pick).
   */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueMutation(operation)
  }

  /** Wait until every accepted profile-bound operation has settled. */
  waitForIdle(): Promise<void> {
    return this.mutationTail
  }

  private async currentActiveId(): Promise<string | null> {
    const metas = await this.inner.listProfiles()
    return metas.find((meta) => meta.active)?.id ?? null
  }

  private async restoreActive(id: string | null): Promise<void> {
    if (id === null) await this.inner.deactivateProfile()
    else await this.inner.activateProfile(id)
  }

  private reloadWithRollback(previousActiveId: string | null): Promise<void> {
    return this.reloader.reload(() => this.restoreActive(previousActiveId))
  }

  private async restoreEdit(
    previousActiveId: string | null,
    editedId: string,
    previousDocument: string
  ): Promise<void> {
    await this.inner.restoreProfileDocument(editedId, previousDocument)
    await this.restoreActive(previousActiveId)
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
