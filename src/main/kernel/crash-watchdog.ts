import { spawn, type ChildProcess } from 'node:child_process'

/** Any byte means an intentional release; EOF means the owning app died. */
export const WATCHDOG_RELEASE_BYTE = 0x52

export function buildWatchdogScript(kernelPid: number): string {
  return [
    '$inputStream = [Console]::OpenStandardInput()',
    '$releaseByte = $inputStream.ReadByte()',
    `if ($releaseByte -eq -1) { & taskkill.exe /PID ${kernelPid} /T /F | Out-Null }`
  ].join('; ')
}

/**
 * Windows kernel crash watchdog — the Job-Object equivalent.
 *
 * clash-verge-rev ties the kernel to the app's Job Object so a killed app takes
 * the kernel down with it; Node exposes no Job Object API. mihomo-party uses the
 * same primitive we do here (its Linux core watchdog): a tiny detached helper
 * whose STDIN is a pipe held open by the app. When the app process dies — crash,
 * force kill, anything — the OS closes our end of the pipe, the helper's read
 * hits EOF, and it `taskkill`s the entire kernel process tree. No polling, no
 * marker files, no extra script assets; the binding is the pipe itself.
 *
 * The one-byte protocol distinguishes a healthy release from app death:
 * `release()` writes a byte before closing the pipe, while an app crash only
 * produces EOF. The helper kills the kernel exclusively on EOF, eliminating
 * the race between closing the pipe and trying to kill the helper itself.
 */
export interface KernelWatchdog {
  /** Dismantle the watch without touching the kernel. */
  release(): void
}

export function attachKernelWatchdog(kernelPid: number): KernelWatchdog {
  if (process.platform !== 'win32' || !kernelPid) return { release(): void {} }

  let helper: ChildProcess | null = null
  let released = false
  try {
    helper = spawn(
      'powershell.exe',
      // Read exactly one byte. A normal release supplies it; abrupt parent death
      // closes the inherited pipe without data and ReadByte returns -1.
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildWatchdogScript(kernelPid)],
      {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true
      }
    )
  } catch {
    // No watchdog is strictly better than a broken spawn path: crash-restart
    // still works, an app crash just leaves an orphan to clean up next launch.
    return { release(): void {} }
  }
  helper.unref()
  helper.on('error', () => {
    /* helper died early: same degraded mode as a failed spawn */
  })
  // If the helper exits before release(), writing the release byte can raise an
  // asynchronous EPIPE on stdin. That degraded watchdog must not take down the
  // Electron main process.
  helper.stdin?.on('error', () => undefined)

  return {
    release(): void {
      if (released) return
      released = true
      const dying: ChildProcess | null = helper
      helper = null
      if (!dying) return
      try {
        // end(data) preserves write-before-EOF ordering on the pipe. The helper
        // observes the release byte and exits without ever executing taskkill.
        dying.stdin?.end(Buffer.from([WATCHDOG_RELEASE_BYTE]))
      } catch {
        /* the pipe is already gone */
      }
    }
  }
}
