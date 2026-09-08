import type { UpdateService } from '../updates/service'
import type { ApplicationState } from './runtime-state'

/**
 * Update adapter seam. Phase 1 keeps the Electron updater driver selection
 * behind this boundary so the Tauri phase can supply a `TauriUpdaterDriver`
 * without touching the shell: the `UpdateService` state machine, IPC surface
 * and renderer contract stay identical.
 */
export interface UpdateAdapter {
  /** The bound update service (start/polling owned by the composition root). */
  readonly service: UpdateService
}

/** Bind a constructed UpdateService into the shell state (disposal + refs). */
export function bindUpdateService(state: ApplicationState, service: UpdateService): UpdateAdapter {
  state.updateService = service
  return { service }
}
