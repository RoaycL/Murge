export interface QuitGuardDeps {
  /**
   * Restore the owned system proxy, retrying internally. Resolves `true` when the
   * proxy is confirmed restored (or there was nothing owned — conflict is safe),
   * `false` when an owned proxy could not be restored.
   */
  restore: () => Promise<boolean>
  /** Stop the kernel / controller (only called after a confirmed restore). */
  stopKernel?: () => Promise<void>
  /** Dispose IPC / services (only called after a confirmed restore). */
  dispose?: () => void | Promise<void>
  /** Actually quit the app (only called after a confirmed restore). */
  quit: () => void
  /** Optional error sink for post-restore cleanup failures (never blocks quit). */
  onCleanupError?: (error: unknown, step: 'stop-kernel' | 'dispose') => void
}

export type QuitFlowResult = 'restore-failed' | 'quitting'

/**
 * The core of the app-before-quit decision, split out so the "never stop the
 * kernel and never quit when the owned proxy could not be restored" invariant is
 * unit-testable without an Electron runtime.
 *
 * When `restore()` resolves `false` the flow returns `'restore-failed'` WITHOUT
 * touching `stopKernel`, `dispose`, or `quit` — the caller keeps the window and
 * kernel alive and lets the user retry. Otherwise the kernel is stopped, services
 * disposed, and `quit()` is invoked. A post-restore cleanup failure is reported
 * to `onCleanupError` but never prevents the app from quitting (the proxy is
 * already confirmed restored and safe).
 */
export async function runQuitFlow(deps: QuitGuardDeps): Promise<QuitFlowResult> {
  if (!(await deps.restore())) {
    return 'restore-failed'
  }
  const fail = (step: 'stop-kernel' | 'dispose') => (error: unknown) => deps.onCleanupError?.(error, step)
  if (deps.stopKernel) {
    await deps.stopKernel().catch(fail('stop-kernel'))
  }
  if (deps.dispose) {
    await Promise.resolve(deps.dispose()).catch(fail('dispose'))
  }
  deps.quit()
  return 'quitting'
}
