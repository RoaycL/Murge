import { net } from 'electron'
import os from 'node:os'

export interface NetworkDetectorGateway {
  /** The host mode currently serving the unified controller. */
  getRunMode(): NetworkRunMode | Promise<NetworkRunMode>
  startKernel(): Promise<unknown>
  startTun(): Promise<unknown>
  stopKernel(): Promise<unknown>
  handleNetworkDown(): Promise<unknown>
  handleNetworkUp(): Promise<unknown>
}

export type NetworkRunMode = 'stopped' | 'kernel' | 'tun'

export interface NetworkDetectorOptions {
  gateway: NetworkDetectorGateway
  /** Poll cadence in seconds. Defaults to 15, clamped to [5, 300]. */
  intervalSeconds?: number
  /** Injectable clock for tests. */
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  isOnlineFn?: () => boolean
  networkInterfacesFn?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
  log?: (message: string) => void
}

/** Interfaces that never count as connectivity (virtual / loopback containers). */
const IGNORED_INTERFACE_PATTERNS = ['lo', 'docker', 'utun', 'tun', 'veth', 'mihomo', 'meta', 'vmnet', 'vEthernet']

/**
 * Connectivity watchdog (sparkle's `network.ts` state machine, adapted).
 *
 * Two failure shapes it closes:
 * 1. Offline (sleep/resume, Wi-Fi switch, cable pull): an owned system proxy
 *    keeps routing HTTP into a listener whose uplinks are dead — every client
 *    fails while the network is down. The detector turns the proxy off (and, on
 *    Windows, stops the kernel so TUN routes do not blackhole traffic either).
 * 2. Back online: a kernel that was stopped for the outage (or that died while
 *    the network was away) is restarted, and the proxy is re-enabled — no user
 *    action needed after a resume.
 *
 * The kernel restart after a restore of connectivity is deliberately gated on
 * the detector having stopped it (`sawOffline`), so the detector never
 * fights the supervisor's own crash-restart or the user's explicit stop.
 */
export class NetworkDetector {
  private readonly options: NetworkDetectorOptions & { intervalSeconds: number }
  private timer: NodeJS.Timeout | null = null
  private generation = 0
  private checking = false
  private sawOffline = false
  /** Exact user-selected host that was serving before this outage. */
  private resumeMode: Exclude<NetworkRunMode, 'stopped'> | null = null
  /** Latches the offline actions (proxy off + kernel stop) per outage episode. */
  private outageHandled = false
  /** A previous outage stop failed; retry `stopKernel` on the next offline tick. */
  private stopKernelPending = false

  constructor(options: NetworkDetectorOptions) {
    const interval = options.intervalSeconds ?? 15
    this.options = {
      ...options,
      intervalSeconds: Math.min(Math.max(interval, 5), 300)
    }
  }

  start(): void {
    if (this.timer) return
    const generation = ++this.generation
    const set = this.options.setIntervalFn ?? setInterval
    this.timer = set(() => void this.tick(generation), this.options.intervalSeconds * 1000)
    this.options.log?.(`[network-detector] started (every ${this.options.intervalSeconds}s)`)
  }

  stop(): void {
    this.generation++
    const clear = this.options.clearIntervalFn ?? clearInterval
    if (this.timer) {
      clear(this.timer)
      this.timer = null
    }
  }

  /** Run one detection cycle immediately (used after powerMonitor resume). */
  async probeNow(): Promise<void> {
    await this.tick(this.generation)
  }

  private hasRealInterface(): boolean {
    const fn = this.options.networkInterfacesFn ?? os.networkInterfaces
    const interfaces = fn()
    return Object.entries(interfaces).some(([name, addrs]) => {
      if (IGNORED_INTERFACE_PATTERNS.some((pattern) => name.toLowerCase().includes(pattern))) return false
      return (addrs ?? []).some((addr) => !addr.internal)
    })
  }

  private async tick(generation: number): Promise<void> {
    if (this.checking || generation !== this.generation) return
    this.checking = true
    try {
      const isOnline = (this.options.isOnlineFn ?? net.isOnline.bind(net))()
      const connected = isOnline && this.hasRealInterface()
      if (connected) {
        if (this.sawOffline) {
          // Order matters: the proxy re-enable needs a live kernel (enable
          // probes the controller), so a kernel the outage stopped comes back
          // FIRST, then the proxy re-enables — and both retry on every tick
          // until they succeed, so a half-healed state never sticks.
          let currentMode = await this.options.gateway.getRunMode()
          if (this.resumeMode && currentMode !== this.resumeMode) {
            try {
              if (this.resumeMode === 'tun') await this.options.gateway.startTun()
              else await this.options.gateway.startKernel()
            } catch (error) {
              this.options.log?.(
                `[network-detector] kernel restart after reconnect failed: ${error instanceof Error ? error.message : error}`
              )
            }
            currentMode = await this.options.gateway.getRunMode()
          }
          // Re-enable an owned proxy only after some host is live. With no
          // pre-outage host there is nothing to wait for.
          let proxyRecovered = false
          if (!this.resumeMode || currentMode !== 'stopped') {
            try {
              await this.options.gateway.handleNetworkUp()
              proxyRecovered = true
            } catch {
              // The proxy service reports failures through its status.
            }
          }
          if (proxyRecovered && (!this.resumeMode || currentMode === this.resumeMode)) {
            this.sawOffline = false
            this.resumeMode = null
          }
        }
      } else if (!this.outageHandled || this.stopKernelPending) {
        this.sawOffline = true
        if (!this.outageHandled) {
          this.outageHandled = true
          const mode = await this.options.gateway.getRunMode()
          this.resumeMode = mode === 'stopped' ? null : mode
          this.stopKernelPending = mode !== 'stopped'
          try {
            await this.options.gateway.handleNetworkDown()
          } catch {
            // The proxy service reports failures through its status.
          }
        }
        if (this.stopKernelPending) {
          try {
            await this.options.gateway.stopKernel()
            this.stopKernelPending = false
          } catch {
            // The supervisor reports stop failures through its status. Leave
            // `stopKernelPending` set so the NEXT offline tick retries instead of
            // letting TUN routes blackhole traffic for the whole outage.
          }
        }
      }
      // The outage actions run once per outage; the recovery retries until the
      // machine is actually healthy again.
      // Keep the episode latched while recovery is incomplete. Otherwise a
      // brief online/offline flap can observe the intentionally stopped host,
      // overwrite resumeMode with null, and forget that TUN must be restored.
      if (connected && !this.sawOffline) this.outageHandled = false
    } finally {
      this.checking = false
    }
  }
}
