/**
 * Application-update state shared between the main process and the renderer.
 *
 * The main process owns the real updater (electron-updater) and reduces its
 * event stream into this small, serializable state machine. The renderer only
 * reads snapshots and issues one of the narrow commands below, so the trusted
 * boundary never exposes electron-updater directly.
 */

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface UpdateProgress {
  /** 0..100, the percentage of the update binary that has been downloaded. */
  percent: number
  /** Download throughput in bytes per second. */
  bytesPerSecond: number
  /** Bytes transferred so far. */
  transferred: number
  /** Total bytes to transfer, or null when the server omits it. */
  total: number | null
}

export interface UpdateState {
  phase: UpdatePhase
  /** Version string of the running build (`app.getVersion()`), or null. */
  currentVersion: string | null
  /** Version string of an update that was found and is downloadable. */
  availableVersion: string | null
  progress: UpdateProgress | null
  error: string | null
  /** True when a downloaded update is ready to be installed on restart. */
  canInstall: boolean
}

export const DEFAULT_UPDATE_STATE: Readonly<UpdateState> = Object.freeze({
  phase: 'idle',
  currentVersion: null,
  availableVersion: null,
  progress: null,
  error: null,
  canInstall: false
})

/**
 * Coerce an unknown value (from a stale IPC payload or a malformed device) into
 * a complete {@link UpdateState}. Unknown or malformed fields keep the value the
 * state machine defaulted to, so a corrupt payload can never destabilize the UI.
 */
export function coerceUpdateState(value: unknown): UpdateState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_UPDATE_STATE }
  }
  const record = value as Record<string, unknown>
  const phases: UpdatePhase[] = ['idle', 'checking', 'available', 'downloading', 'downloaded', 'not-available', 'error']
  const progressRaw = record.progress
  const progress: UpdateProgress | null =
    typeof progressRaw === 'object' && progressRaw !== null && !Array.isArray(progressRaw)
      ? {
          percent: typeof (progressRaw as Record<string, unknown>).percent === 'number'
            ? (progressRaw as Record<string, unknown>).percent as number
            : 0,
          bytesPerSecond: typeof (progressRaw as Record<string, unknown>).bytesPerSecond === 'number'
            ? (progressRaw as Record<string, unknown>).bytesPerSecond as number
            : 0,
          transferred: typeof (progressRaw as Record<string, unknown>).transferred === 'number'
            ? (progressRaw as Record<string, unknown>).transferred as number
            : 0,
          total: typeof (progressRaw as Record<string, unknown>).total === 'number'
            ? (progressRaw as Record<string, unknown>).total as number
            : null
        }
      : null
  return {
    phase: typeof record.phase === 'string' && phases.includes(record.phase as UpdatePhase)
      ? record.phase as UpdatePhase
      : DEFAULT_UPDATE_STATE.phase,
    currentVersion: typeof record.currentVersion === 'string' ? record.currentVersion : DEFAULT_UPDATE_STATE.currentVersion,
    availableVersion: typeof record.availableVersion === 'string' ? record.availableVersion : DEFAULT_UPDATE_STATE.availableVersion,
    progress,
    error: typeof record.error === 'string' ? record.error : DEFAULT_UPDATE_STATE.error,
    canInstall: typeof record.canInstall === 'boolean' ? record.canInstall : DEFAULT_UPDATE_STATE.canInstall
  }
}
