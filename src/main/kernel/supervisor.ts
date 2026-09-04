import { EventEmitter } from 'node:events'
import type { KernelStatus } from '@shared/runtime'
import { ProtocolError, ProtocolErrorCode, toProtocolError } from '@shared/protocol-errors'
import { BoundedLogBuffer, type KernelLog } from './bounded-log'
import type { KernelWatchdog } from './crash-watchdog'
import type {
  KernelBinary,
  KernelConfig,
  KernelDependencies,
  KernelExitInfo,
  KernelProcessHandle
} from './types'

const STOPPED: KernelStatus = {
  phase: 'stopped',
  pid: null,
  version: null,
  controllerUrl: null,
  startedAt: null,
  lastError: null
}

export interface KernelSupervisorOptions {
  /** Max time to wait for readiness after a spawn. Default 5000ms. */
  startTimeoutMs?: number
  /** Max time to wait for a graceful SIGTERM stop. Default 5000ms. */
  stopTimeoutMs?: number
  /** Extra time to wait after SIGKILL before declaring failure. Default 3000ms. */
  forceKillTimeoutMs?: number
  /** Max unexpected-exit restarts before giving up. Default 10. */
  maxRestarts?: number
  /** Base crash backoff; doubled per attempt. Default 250ms. */
  backoffMs?: number
  /** Upper bound on a single backoff delay. Default 5000ms. */
  maxBackoffMs?: number
  /**
   * Continuous runtime that refills the crash-restart budget: a kernel that ran
   * this long had a fresh, independent failure, so a later exit restarts with a
   * full budget again. Default 60_000ms; 0 disables the reset.
   */
  restartBudgetResetMs?: number
  /**
   * Attach a crash watchdog to a freshly spawned kernel. Contract: when the APP
   * dies while the kernel lives, the watchdog force-kills the kernel (the
   * Job-Object guarantee, clash-verge-rev style). The supervisor calls
   * `release()` on natural exit/stop so a healthy shutdown never triggers it.
   */
  attachWatchdog?: (kernelPid: number) => KernelWatchdog
  /**
   * Readiness regex tested against accumulated stdout. When null/empty, spawn
   * success means ready. The fixture emits a ready line to exercise this path.
   */
  readinessPattern?: RegExp | null
  /** Rolling log byte cap. Default 256 KiB. */
  maxLogBytes?: number
  /** Rolling log entry cap. Default 4000. */
  maxLogEntries?: number
}

interface Readiness {
  resolve: () => void
  reject: (error: ProtocolError) => void
  timer: NodeJS.Timeout
}

interface ExitWait {
  resolve: (exited: boolean) => void
  timer: NodeJS.Timeout
}

/**
 * Owns the kernel process lifecycle.
 *
 * Start/stop are serialised through a single promise chain so concurrent calls
 * queue instead of racing: a second start is idempotent, and a stop submitted
 * while a start is still in flight runs only after the start settles. The
 * process is driven through an injected `KernelProcessAdapter`; the supervisor
 * never touches Node streams directly and never opens a socket.
 *
 * Eventing: the supervisor emits `status` events (and exposes `onStatus`) on
 * every transition so the main process can forward them to the renderer.
 */
export class KernelSupervisor extends EventEmitter {
  private readonly deps: KernelDependencies
  private readonly readinessPattern: RegExp | null
  private readonly startTimeoutMs: number
  private readonly stopTimeoutMs: number
  private readonly forceKillTimeoutMs: number
  private readonly maxRestarts: number
  private readonly backoffMs: number
  private readonly maxBackoffMs: number
  private readonly restartBudgetResetMs: number
  private readonly attachWatchdog?: (kernelPid: number) => KernelWatchdog
  private readonly log: BoundedLogBuffer

  private status: KernelStatus = { ...STOPPED }
  private chain: Promise<unknown> = Promise.resolve()
  private handle: KernelProcessHandle | null = null
  private config: KernelConfig | null = null
  private isStopping = false
  private restartCount = 0
  private restartTimer: NodeJS.Timeout | null = null
  /** Armed while the kernel runs; resets the crash budget after sustained uptime. */
  private healthyTimer: NodeJS.Timeout | null = null
  /** Attached crash watchdog for the live kernel; released on exit/stop. */
  private watchdog: KernelWatchdog | null = null
  private readiness: Readiness | null = null
  private exitWait: ExitWait | null = null
  /** In-flight post-exit work (config cleanup + status/restart). Never on the
   * lifecycle chain, so awaiting it from stop()/start() cannot deadlock. */
  private exitWork: Promise<void> | null = null
  private stdoutBuf = ''

  /** The config the supervisor currently materialized, or null before start. */
  getActiveConfig(): KernelConfig | null {
    return this.config
  }

  constructor(deps: KernelDependencies, options: KernelSupervisorOptions = {}) {
    super()
    this.deps = deps
    this.readinessPattern = options.readinessPattern ?? null
    this.startTimeoutMs = options.startTimeoutMs ?? 5000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000
    this.forceKillTimeoutMs = options.forceKillTimeoutMs ?? 3000
    this.maxRestarts = options.maxRestarts ?? 10
    this.backoffMs = options.backoffMs ?? 250
    this.maxBackoffMs = options.maxBackoffMs ?? 5000
    this.restartBudgetResetMs = options.restartBudgetResetMs ?? 60_000
    this.attachWatchdog = deps.attachWatchdog ?? options.attachWatchdog
    this.log = new BoundedLogBuffer(options.maxLogBytes ?? 256 * 1024, options.maxLogEntries ?? 4000)
  }

  getStatus(): KernelStatus {
    return { ...this.status }
  }

  onStatus(listener: (status: KernelStatus) => void): () => void {
    const handler = (status: KernelStatus): void => listener({ ...status })
    this.on('status', handler)
    listener({ ...this.status })
    return () => this.off('status', handler)
  }

  getRecentLogs(limit = 200): KernelLog[] {
    return this.log.snapshot(limit)
  }

  async start(): Promise<KernelStatus> {
    return this.withLifecycle(async () => {
      if (this.status.phase === 'running' || this.status.phase === 'starting' || this.status.phase === 'stopping') {
        return this.getStatus()
      }
      // A still-alive process (e.g. one that survived SIGKILL) must be stopped
      // before a second kernel is spawned, otherwise the old process leaks.
      if (this.handle != null) {
        throw new ProtocolError(
          ProtocolErrorCode.KERNEL_RUNNING,
          'A kernel process is still running; stop it before starting again.'
        )
      }
      // If a previous process's exit work is still removing its temp config,
      // wait so we never materialize/respawn over an uncleaned workspace.
      const priorWork = this.exitWork
      if (priorWork) await priorWork
      this.clearRestartTimer()
      this.restartCount = 0
      await this.doStart()
      return this.getStatus()
    })
  }

  async stop(): Promise<KernelStatus> {
    return this.withLifecycle(async () => {
      this.clearRestartTimer()
      this.restartCount = 0
      if (this.status.phase === 'stopped') return this.getStatus()

      const handle = this.handle
      if (!handle) {
        // Either never started, or the process already exited. If that prior
        // exit is still removing its temp config, wait so stop()/before-quit
        // never finish before the workspace is gone.
        const priorWork = this.exitWork
        if (priorWork) await priorWork
        this.setStatus({ phase: 'stopped', pid: null })
        return this.getStatus()
      }

      this.isStopping = true
      this.clearHealthyTimer()
      // The kernel is exiting on OUR request: the watchdog must not kill it.
      this.watchdog?.release()
      this.watchdog = null
      this.setStatus({ phase: 'stopping' })
      const exited = await this.terminate(handle)
      if (exited) {
        // The process exited and handleExit already cleaned the temp config.
        return this.getStatus()
      }

      // The process survived even SIGKILL, so it is almost certainly still
      // running. Never report it as stopped or drop its pid/handle: doing so
      // would let a later start() spawn a second kernel that shadows the first.
      // The temp config is kept because the live process may still read it, and
      // a subsequent stop() can retry termination.
      this.isStopping = false
      this.setStatus({
        phase: 'failed',
        pid: handle.pid ?? this.status.pid,
        lastError: 'Kernel survived SIGKILL and may still be running.'
      })
      throw new ProtocolError(ProtocolErrorCode.KERNEL_STOP_TIMEOUT, 'Kernel did not exit after SIGKILL.')
    })
  }

  /**
   * Send SIGTERM then SIGKILL, waiting for a real exit after each signal.
   * Resolves true only once the process has actually exited (and handleExit has
   * removed its temp config); resolves false when it survives even SIGKILL, in
   * which case the caller must keep the handle and pid tracked.
   */
  private async terminate(handle: KernelProcessHandle): Promise<boolean> {
    handle.sendSignal('SIGTERM')
    const graceful = await this.waitForExit(handle, this.stopTimeoutMs)
    if (graceful) return true
    handle.sendSignal('SIGKILL')
    return this.waitForExit(handle, this.forceKillTimeoutMs)
  }

  private async doStart(): Promise<void> {
    this.stdoutBuf = ''
    this.setStatus({ phase: 'starting', lastError: null })

    let binary: KernelBinary
    try {
      binary = await this.deps.resolver.resolve()
    } catch (error) {
      return this.raiseFailed(toProtocolError(error))
    }

    await this.handleStalePid()

    let config: KernelConfig
    try {
      config = await this.deps.configStore.materialize(binary, this.deps.secret)
    } catch (error) {
      return this.raiseFailed(toProtocolError(error))
    }
    this.config = config

    let handle: KernelProcessHandle
    try {
      handle = this.deps.adapter.spawn({
        ...binary,
        args: [...binary.args, ...(config.args ?? [])],
        cwd: config.rootDir,
        env: { ...(binary.env ?? {}), ...(config.env ?? {}) }
      })
    } catch (error) {
      await this.cleanupConfig()
      return this.raiseFailed(toProtocolError(error))
    }
    this.handle = handle
    // Attach listeners even when no PID was reported, so a failed spawn's
    // async 'error' event is always consumed instead of surfacing unhandled.
    this.attach(handle, binary)

    if (!handle.pid) {
      await this.cleanupHandle()
      await this.cleanupConfig()
      return this.raiseFailed(new ProtocolError(ProtocolErrorCode.KERNEL_SPAWN_FAILED, 'Kernel process did not report a PID.'))
    }

    this.setStatus({ pid: handle.pid, version: binary.version ?? null, startedAt: null, lastError: null })

    // Attach the crash watchdog as soon as the kernel EXISTS, not after the
    // readiness handshake: the spawn→ready window (up to startTimeoutMs) has a
    // live process that a killed app must not orphan. If readiness then fails,
    // stop()/abort paths still release it before terminating.
    this.watchdog?.release()
    this.watchdog = this.attachWatchdog?.(handle.pid ?? 0) ?? null

    try {
      await this.awaitReady(handle)
    } catch (error) {
      // The half-started process may still be alive. Abort it with the same
      // bounded termination used by stop(): never drop the handle or delete its
      // config until we know the process has actually exited.
      const underlying = toProtocolError(error)
      const exited = await this.terminate(handle)
      if (exited) return this.raiseFailed(underlying)
      // The process survived even SIGKILL. Keep it tracked (failed + pid +
      // handle) so start() refuses a second kernel and the config is preserved.
      this.setStatus({
        phase: 'failed',
        pid: handle.pid ?? this.status.pid,
        lastError: `Kernel did not exit after SIGKILL (start failed: ${underlying.message})`
      })
      throw new ProtocolError(
        ProtocolErrorCode.KERNEL_STOP_TIMEOUT,
        `Kernel did not exit after SIGKILL while aborting an unstarted kernel (${underlying.message}).`
      )
    }

    this.setStatus({ phase: 'running', startedAt: new Date().toISOString() })
    // Arm the sustained-run reset: once the kernel has been up this long, the
    // crash budget refills — a later exit is a fresh, independent failure and
    // must not inherit the previous incident's exhausted restarts.
    this.clearHealthyTimer()
    if (this.maxRestarts > 0 && this.restartBudgetResetMs > 0) {
      this.healthyTimer = setTimeout(() => {
        this.healthyTimer = null
        if (this.status.phase === 'running' && this.restartCount > 0) {
          this.restartCount = 0
          this.log.append('stdout', '[supervisor] sustained run; crash-restart budget reset\n')
        }
      }, this.restartBudgetResetMs)
    }
  }

  private clearHealthyTimer(): void {
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer)
      this.healthyTimer = null
    }
  }

  private async handleStalePid(): Promise<void> {
    const recorded = this.status.pid
    if (recorded == null) return
    if (this.deps.adapter.isProcessAlive(recorded)) {
      this.log.append('stdout', `[supervisor] recorded pid=${recorded} is still alive; proceeding with a fresh spawn.\n`)
    } else {
      this.setStatus({ pid: null })
      this.log.append('stdout', `[supervisor] cleared stale pid=${recorded}.\n`)
    }
  }

  private attach(handle: KernelProcessHandle, binary: KernelBinary): void {
    this.log.append('stdout', `[supervisor] spawned pid=${handle.pid} cmd=${binary.command} ${binary.args.join(' ')}\n`)
    handle.onStdout((text) => {
      this.log.append('stdout', text)
      this.acceptReadinessFromStdout(text)
    })
    handle.onStderr((text) => this.log.append('stderr', text))
    handle.onExit((info) => {
      if (this.handle !== handle) return
      this.handle = null
      this.handleExit(info)
    })
    handle.onError((error) => {
      if (this.handle !== handle) return
      this.handleError(handle, error)
    })
  }

  private acceptReadinessFromStdout(text: string): void {
    if (!this.readiness || !this.readinessPattern) return
    this.stdoutBuf += text
    if (this.readinessPattern.test(this.stdoutBuf)) {
      clearTimeout(this.readiness.timer)
      const r = this.readiness
      this.readiness = null
      r.resolve()
    }
  }

  private awaitReady(handle: KernelProcessHandle): Promise<void> {
    if (!this.readinessPattern) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.readiness?.timer === timer) this.readiness = null
        reject(new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, 'Kernel did not report ready within the start timeout.'))
      }, this.startTimeoutMs)
      this.readiness = { resolve, reject, timer }
    })
  }

  private rejectReadiness(error: ProtocolError): void {
    if (!this.readiness) return
    clearTimeout(this.readiness.timer)
    const r = this.readiness
    this.readiness = null
    r.reject(error)
  }

  private handleExit(info: KernelExitInfo): void {
    // The process has exited, so its temp workspace (which may hold the
    // controller secret) is no longer needed. Run all post-exit work on a single
    // awaited promise: config cleanup is finished before the exit wait is
    // resolved (so stop()/before-quit never complete early) and before a
    // crash-restart is scheduled (so a fresh directory never materializes over
    // an uncleaned one).
    this.clearHealthyTimer()
    this.watchdog?.release()
    this.watchdog = null
    this.rejectReadiness(new ProtocolError(ProtocolErrorCode.KERNEL_CRASHED, `Kernel ${this.describeExit(info)}`))
    const wasRunning = this.status.phase === 'running'
    const desc = this.describeExit(info)
    this.exitWork = (async () => {
      await this.cleanupConfig()
      if (this.exitWait) {
        clearTimeout(this.exitWait.timer)
        const w = this.exitWait
        this.exitWait = null
        w.resolve(true)
      }
      if (this.isStopping) {
        this.isStopping = false
        this.setStatus({ phase: 'stopped', pid: null })
        return
      }
      this.setStatus({ phase: 'failed', pid: null, lastError: `Kernel ${desc}` })
      if (wasRunning) {
        this.scheduleRestart(desc)
      }
    })()
  }

  private handleError(handle: KernelProcessHandle, error: Error): void {
    const protocolError = new ProtocolError(ProtocolErrorCode.KERNEL_SPAWN_FAILED, error.message)
    this.rejectReadiness(protocolError)

    // ChildProcess can emit `error` both when spawn failed and when an operation
    // on an already-running child failed. Never drop a handle for a PID that is
    // still alive: keeping it tracked prevents a second kernel from starting
    // and lets stop() retry termination without deleting a config the process
    // may still be reading.
    const pid = handle.pid
    if (pid != null && this.deps.adapter.isProcessAlive(pid)) {
      this.setStatus({ phase: 'failed', pid, lastError: `Kernel process error: ${error.message}` })
      return
    }

    this.handle = null
    // A failed spawn has no later `exit` event on which cleanup can safely rely.
    // Mirror handleExit's awaited cleanup contract so start()/stop()/quit never
    // finish while the secret-bearing workspace remains on disk.
    this.exitWork = (async () => {
      await this.cleanupConfig()
      if (this.exitWait) {
        clearTimeout(this.exitWait.timer)
        const waiter = this.exitWait
        this.exitWait = null
        waiter.resolve(true)
      }
      this.setStatus({ phase: 'failed', pid: null, lastError: `Kernel spawn failed: ${error.message}` })
    })()
  }

  private scheduleRestart(reason: string): void {
    if (this.restartCount >= this.maxRestarts) return
    this.restartCount += 1
    const delay = Math.min(this.backoffMs * 2 ** (this.restartCount - 1), this.maxBackoffMs)
    this.log.append('stdout', `[supervisor] crash detected; restart ${this.restartCount}/${this.maxRestarts} in ${delay}ms (${reason})\n`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.withLifecycle(async () => {
        if (this.handle != null || this.status.phase !== 'failed') return
        try {
          await this.doStart()
        } catch {
          // doStart already recorded the failure; the cap prevents an infinite loop.
        }
      })
    }, delay)
  }

  private waitForExit(handle: KernelProcessHandle, timeoutMs: number): Promise<boolean> {
    if (this.handle !== handle) {
      // The process already exited, so the exit event is gone. Wait for its
      // cleanup to finish before reporting so a caller never proceeds while the
      // temp workspace is still being removed.
      return (this.exitWork ?? Promise.resolve()).then(() => true)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.exitWait?.resolve === resolve) this.exitWait = null
        resolve(false)
      }, timeoutMs)
      this.exitWait = { resolve, timer }
    })
  }

  private async cleanupHandle(): Promise<void> {
    const handle = this.handle
    if (!handle) return
    this.handle = null
    try {
      handle.sendSignal('SIGKILL')
    } catch {
      // best effort
    }
    this.setStatus({ pid: null })
  }

  private async cleanupConfig(): Promise<void> {
    const config = this.config
    this.config = null
    if (config) {
      try {
        await this.deps.configStore.cleanup(config)
      } catch {
        // best effort
      }
    }
  }

  private raiseFailed(error: ProtocolError): never {
    this.setStatus({ phase: 'failed', lastError: error.message })
    throw error
  }

  private setStatus(patch: Partial<KernelStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', { ...this.status })
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private describeExit(info: KernelExitInfo): string {
    if (info.signal) return `terminated by ${info.signal}`
    return `exited with code ${info.code ?? 'unknown'}`
  }

  private withLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => undefined)
    return run
  }
}
