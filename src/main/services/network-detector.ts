import { net } from 'electron'
import os from 'node:os'

export interface NetworkDetectorGateway {
  /** True when the kernel is running (phase `running`). */
  isKernelRunning(): boolean | Promise<boolean>
  startKernel(): Promise<unknown>
  stopKernel(): Promise<unknown>
  handleNetworkDown(): Promise<unknown>
  handleNetworkUp(): Promise<unknown>
}

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
  /** Latches the offline actions (proxy off + kernel stop) per outage episode. */
  private outageHandled = false

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
          if (!(await this.options.gateway.isKernelRunning())) {
            try {
              await this.options.gateway.startKernel()
            } catch (error) {
              this.options.log?.(
                `[network-detector] kernel restart after reconnect failed: ${error instanceof Error ? error.message : error}`
              )
            }
          }
          try {
            await this.options.gateway.handleNetworkUp()
          } catch {
            // The proxy service reports failures through its status.
          }
          if (await this.options.gateway.isKernelRunning()) this.sawOffline = false
        }
      } else if (!this.outageHandled) {
        this.sawOffline = true
        this.outageHandled = true
        try {
          await this.options.gateway.handleNetworkDown()
        } catch {
          // The proxy service reports failures through its status.
        }
        if (await this.options.gateway.isKernelRunning()) {
          try {
            await this.options.gateway.stopKernel()
          } catch {
            // The supervisor reports stop failures through its status.
          }
        }
      }
      // The outage actions run once per outage; the recovery retries until the
      // machine is actually healthy again.
      if (connected) this.outageHandled = false
    } finally {
      this.checking = false
    }
  }
}
