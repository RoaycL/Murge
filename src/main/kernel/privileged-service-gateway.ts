import type { KernelGateway } from '../../shared/gateways'
import type { KernelStatus } from '../../shared/runtime'
import type { CoreSettings } from '../../shared/core-settings'
import type { GeodataSettings } from '../../shared/geodata'
import type { TunConfigModel } from '../../shared/tun-config'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import { generateMihomoTunConfig, generateProxiedTunConfig } from '../tun/mihomo-tun-config'
import type { TunServiceClient } from '../tun/service-client'

export interface PrivilegedKernelRuntime {
  mixedPort: number
  httpPort?: number
  socksPort?: number
  controllerPort: number
  controllerHost?: '127.0.0.1' | '0.0.0.0'
  allowLan?: boolean
  controllerPanel?: boolean
  secret: string
}

export interface PrivilegedKernelProfileSources {
  readActiveDocument(): Promise<string | null>
  readTunConfig(): Promise<TunConfigModel>
  readCore(): Promise<CoreSettings>
  readGeodata(): Promise<GeodataSettings>
}

export interface PrivilegedKernelReadiness {
  waitUntilReady(input: PrivilegedKernelRuntime & { signal: AbortSignal }): Promise<{ version?: string } | void>
}

const STOPPED: KernelStatus = {
  phase: 'stopped', pid: null, version: null, controllerUrl: null,
  startedAt: null, lastError: null
}

/**
 * The Windows production kernel gateway backed by the installed LocalSystem
 * service. The service owns one mihomo process for the complete application
 * runtime, including when TUN is off. TUN is therefore a controller config
 * mutation, never a second process or a port hand-off.
 */
export class PrivilegedServiceKernelGateway implements KernelGateway {
  private status: KernelStatus = { ...STOPPED }
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(status: KernelStatus) => void>()

  constructor(
    private readonly client: TunServiceClient,
    private readonly runtimeFactory: () => PrivilegedKernelRuntime | Promise<PrivilegedKernelRuntime>,
    private readonly profileSources: PrivilegedKernelProfileSources,
    private readonly readiness: PrivilegedKernelReadiness,
    private readonly device: string,
    private readonly readyTimeoutMs = 10_000,
    private readonly canStart: () => boolean | Promise<boolean> = () => true,
    private readonly prepareStart: (runtime: PrivilegedKernelRuntime) => void | Promise<void> = () => undefined,
    private readonly versionSelection: () => Promise<{ channel: 'stable' | 'specific'; specificVersion: string | null }> = async () => ({ channel: 'stable', specificVersion: null })
  ) {}

  getStatus(): KernelStatus { return { ...this.status } }

  onStatus(listener: (status: KernelStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => this.listeners.delete(listener)
  }

  /** Remove a service-owned child left by an abnormal GUI exit before replaying
   * the persisted runtime intent. This also guarantees stale TUN routes are gone. */
  initialize(): Promise<void> {
    return this.serialize(async () => {
      // One immediate probe keeps application startup responsive. If the SCM
      // delayed-auto-start service is not listening yet, start() performs the
      // bounded retry and repeats this stale-session reconciliation.
      const response = await this.client.reconcile()
      if (response.outcome === 'running' || response.outcome === 'starting' || response.outcome === 'stopping') {
        await this.client.stop()
      }
      this.setStatus({ ...STOPPED })
    })
  }

  start(): Promise<KernelStatus> {
    return this.serialize(async () => {
      if (this.status.phase === 'running' || this.status.phase === 'starting') return this.getStatus()
      if (!(await this.canStart())) {
        throw new ProtocolError(ProtocolErrorCode.UNSUPPORTED, '内核已停用，请先在通用设置中启用内核。')
      }
      const runtime = await this.runtimeFactory()
      this.setStatus({
        phase: 'starting', pid: null, version: null,
        controllerUrl: `http://127.0.0.1:${runtime.controllerPort}`,
        startedAt: null, lastError: null
      })
      try {
        // Reconcile every start. An abnormal GUI exit leaves a service-owned
        // core with the previous run's random controller secret/ports; it must
        // be stopped before starting this run's authenticated endpoint.
        const stale = await this.retryService(() => this.client.reconcile())
        if (stale.outcome === 'running' || stale.outcome === 'starting' || stale.outcome === 'stopping') {
          await this.client.stop()
        }
        // Build everything that can take time before reclaiming the ports. The
        // service start follows the reclaim immediately, leaving a competing
        // application's watchdog the smallest possible opportunity to bind the
        // ports again.
        const profile = await this.buildProfile(runtime)
        const selection = await this.versionSelection()
        const requestedVersion = selection.channel === 'specific' ? selection.specificVersion ?? undefined : undefined
        // Only after the service-owned child is gone may we terminate remaining
        // listeners. No process-family classification is performed: configured
        // ports belong to this requested application start.
        await this.prepareStart(runtime)
        const owned = await this.startProfile(profile, requestedVersion)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.readyTimeoutMs)
        try {
          const ready = await this.readiness.waitUntilReady({ ...runtime, signal: controller.signal })
          const observedVersion = ready && typeof ready.version === 'string' ? ready.version : null
          if (requestedVersion && observedVersion?.replace(/^v/, '') !== requestedVersion.replace(/^v/, '')) {
            throw new ProtocolError(
              ProtocolErrorCode.ARTIFACT_HASH_MISMATCH,
              `内核版本未生效：请求 ${requestedVersion}，实际 ${observedVersion ?? '未知'}`
            )
          }
          this.setStatus({
            phase: 'running', pid: owned.pid,
            version: observedVersion,
            controllerUrl: `http://127.0.0.1:${runtime.controllerPort}`,
            startedAt: new Date().toISOString(), lastError: null
          })
          return this.getStatus()
        } finally {
          clearTimeout(timer)
        }
      } catch (error) {
        await this.client.stop().catch(() => undefined)
        const message = error instanceof Error ? error.message : 'Privileged mihomo failed to start'
        this.setStatus({ ...STOPPED, phase: 'failed', lastError: message })
        throw new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, message)
      }
    })
  }

  stop(): Promise<KernelStatus> {
    return this.serialize(async () => {
      if (this.status.phase === 'stopped') return this.getStatus()
      this.setStatus({ ...this.status, phase: 'stopping' })
      try {
        await this.client.stop()
        this.setStatus({ ...STOPPED })
        return this.getStatus()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Privileged mihomo failed to stop'
        this.setStatus({ ...this.status, phase: 'failed', lastError: message })
        throw error
      }
    })
  }

  /** Poll the service's process identity. Returns false only when a process that
   * this gateway believed live is now definitively gone. */
  reconcileLiveness(): Promise<boolean> {
    // Share the start/stop queue: the five-second monitor must never reconcile
    // halfway through a service start and overwrite its transitional status.
    return this.serialize(async () => {
      const response = await this.client.reconcile()
      const live = response.outcome === 'running' || response.outcome === 'starting'
      if (!live && (this.status.phase === 'running' || this.status.phase === 'starting')) {
        this.setStatus({ ...STOPPED, phase: 'failed', lastError: 'Privileged mihomo exited unexpectedly' })
        return false
      }
      return live
    })
  }

  private async buildProfile(runtime: PrivilegedKernelRuntime): Promise<string> {
    const [document, tunConfig, core, geodata] = await Promise.all([
      this.profileSources.readActiveDocument(),
      this.profileSources.readTunConfig(),
      this.profileSources.readCore(),
      this.profileSources.readGeodata()
    ])
    const common = { ...runtime, device: this.device, tunConfig, tunEnabled: false }
    return document
      ? generateProxiedTunConfig({ ...common, document, core, geodata })
      : generateMihomoTunConfig(common)
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** The SCM service is delayed-auto-start. Absorb that bounded boot window so
   * login startup does not show two spurious failures before the pipe appears. */
  private async retryService<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.readyTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (!(error instanceof ProtocolError) || error.code !== ProtocolErrorCode.UPSTREAM_UNREACHABLE) throw error
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    throw lastError ?? new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'Privileged service is unavailable')
  }

  /** Recover the ambiguous "service started the child but the reply was lost"
   * case by reconciling ownership before retrying. Blindly sending a second
   * start would turn a successful first start into a conflict and orphan the
   * only live controller from the GUI's point of view. */
  private async startProfile(profile: string, version?: string): Promise<{ sessionId: string; pid: number }> {
    const deadline = Date.now() + this.readyTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        return await this.client.start(profile, undefined, version)
      } catch (error) {
        lastError = error
        if (!(error instanceof ProtocolError) || error.code !== ProtocolErrorCode.UPSTREAM_UNREACHABLE) throw error
        try {
          const reconciled = await this.client.reconcile()
          if (reconciled.outcome === 'running') {
            const owned = this.client.getOwnedSession()
            if (owned) return owned
          }
        } catch {
          // The service may still be opening its pipe; retry within the bound.
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    throw lastError ?? new ProtocolError(ProtocolErrorCode.UPSTREAM_UNREACHABLE, 'Privileged service is unavailable')
  }

  private setStatus(status: KernelStatus): void {
    this.status = { ...status }
    const snapshot = this.getStatus()
    for (const listener of this.listeners) listener(snapshot)
  }
}
