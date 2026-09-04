import { spawn, type ChildProcess } from 'node:child_process'

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
 * The helper is `detached` so it must NOT be reaped by the app's exit; it lives
 * only until its stdin closes (app death OR an explicit `release()` when the
 * kernel exited on its own) and then kills-or-exits.
 */
export interface KernelWatchdog {
  /** End the watch: called when the kernel exited by itself. */
  release(): void
}

export function attachKernelWatchdog(kernelPid: number): KernelWatchdog {
  if (process.platform !== 'win32' || !kernelPid) return { release(): void {} }

  let helper: ChildProcess
  try {
    helper = spawn(
      'cmd.exe',
      // `more` blocks reading stdin; on EOF (the app died or released the pipe)
      // it falls through and the whole kernel tree is force-killed. `/T` covers
      // any children mihomo spawned (e.g. Wintun helpers).
      ['/d', '/s', '/c', `more > NUL & taskkill /PID ${kernelPid} /T /F`],
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

  return {
    release(): void {
      try {
        helper.stdin?.end()
      } catch {
        /* the pipe is already gone */
      }
    }
  }
}
