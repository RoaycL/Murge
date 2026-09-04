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
 * `release()` must NEVER be a plain stdin close: EOF would fall through to the
 * helper's `taskkill` and force-kill a kernel the app is still using or trying
 * to stop gracefully. Instead release kills the HELPER process tree — a dead
 * helper can never run its kill command, and the app death guarantee only needs
 * helpers that are still alive.
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
      'cmd.exe',
      // `more` blocks reading stdin; on EOF (the app died) it falls through and
      // the whole kernel tree is force-killed. `/T` covers any children mihomo
      // spawned (e.g. Wintun helpers).
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
      if (released) return
      released = true
      // Kill the helper ITSELF (cmd + its `more` child). Relying on stdin EOF
      // would run the helper's taskkill against a kernel the app may still be
      // stopping gracefully — or against a REUSED pid after stop/start cycles.
      const dying: ChildProcess | null = helper
      helper = null
      if (!dying) return
      try {
        dying.stdin?.destroy()
      } catch {
        /* the pipe is already gone */
      }
      if (dying.pid) {
        try {
          spawn('taskkill', ['/PID', String(dying.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          }).unref()
        } catch {
          /* a surviving helper is inert unless the app itself dies */
        }
      }
    }
  }
}
