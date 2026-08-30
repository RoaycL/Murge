export type StartupPhase = 'idle' | 'updating' | 'error' | 'unsupported'
export interface StartupStatus {
  supported: boolean
  enabled: boolean
  phase: StartupPhase
  errorMessage: string | null
}

