import type {
  InternetLatencySampler,
  KernelGateway,
  MihomoGateway,
  ProfileGateway,
  SystemProxyGateway
} from '@shared/gateways'
import type { MihomoConnection, MihomoProxy } from '@shared/mihomo-api'
import type { ProfileMeta } from '@shared/profiles'
import type { KernelStatus, OutboundMode } from '@shared/runtime'
import type { RuntimeAccent } from '@shared/runtime-accent'
import type { SystemProxyStatus } from '@shared/system-proxy'
import type { TunGateway, TunStatus } from '@shared/tun'

export type TrayDirectory = 'application' | 'working' | 'kernel' | 'logs'

export interface TrayMenuItem {
  id: string
  label?: string
  enabled?: boolean
  checked?: boolean
  type?: 'separator' | 'checkbox' | 'radio'
  submenu?: TrayMenuItem[]
  click?: () => void
}

export interface TrayView {
  isReady(): boolean
  setToolTip(value: string): void
  setMenu(items: TrayMenuItem[]): void
  setRuntimeAppearance(accent: RuntimeAccent, dark: boolean): void
  onActivate(listener: () => void): () => void
  /** Refresh authoritative state before showing the native context menu. */
  onMenuOpen(listener: () => Promise<void>): () => void
  destroy(): void
}

export interface TrayControllerOptions {
  productName: string
  kernel: KernelGateway
  view: TrayView
  showWindow(): void
  quit(): void
  systemProxy?: SystemProxyGateway
  tun?: TunGateway
  mihomo?: MihomoGateway
  profiles?: ProfileGateway
  internetLatency?: InternetLatencySampler
  resolveGroupOrder?(): Promise<string[]>
  reloadConfig?(): Promise<void>
  restartKernel?(): Promise<void>
  openDirectory?(directory: TrayDirectory): void | Promise<void>
  copyText?(value: string): void
  onCheckUpdate?(): void
  onError?(error: unknown): void
}

const PHASE_LABEL: Record<KernelStatus['phase'], string> = {
  stopped: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止', failed: '启动失败'
}
const MODE_LABEL: Record<OutboundMode, string> = { rule: '规则', global: '全局', direct: '直连' }
const SELECTABLE_GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback'])

const EMPTY_SYSTEM_PROXY: SystemProxyStatus = {
  supported: false,
  phase: 'unsupported',
  address: null,
  port: null,
  proxyOverride: null,
  errorMessage: null,
  conflictDetail: null,
  updatedAt: null
}
const EMPTY_TUN: TunStatus = {
  supported: false,
  phase: 'unsupported',
  errorMessage: null,
  conflictDetail: null,
  updatedAt: null
}

function selectedMember(proxy: MihomoProxy): string | null {
  if (typeof proxy.fixed === 'string' && proxy.fixed.length > 0) return proxy.fixed
  return typeof proxy.now === 'string' && proxy.now.length > 0 ? proxy.now : null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function processRows(connections: MihomoConnection[]): Array<{ name: string; bytes: number }> {
  const totals = new Map<string, number>()
  for (const connection of connections) {
    const name = connection.metadata.process?.trim() || '未知进程'
    totals.set(name, (totals.get(name) ?? 0) + connection.upload + connection.download)
  }
  return [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, 12)
}

/** Main-process tray state owner. No renderer state is trusted or mirrored optimistically. */
export class TrayController {
  private status: KernelStatus = { phase: 'stopped', pid: null, version: null, controllerUrl: null, startedAt: null, lastError: null }
  private systemProxyStatus = EMPTY_SYSTEM_PROXY
  private tunStatus = EMPTY_TUN
  private mode: OutboundMode = 'rule'
  private mixedPort: number | null = null
  private proxies: Record<string, MihomoProxy> = {}
  private groupOrder: string[] = []
  private profiles: ProfileMeta[] = []
  private connections: MihomoConnection[] = []
  private networkLatencyMs: number | null = null
  private busy = false
  private disposed = false
  private refreshPromise: Promise<void> | null = null
  private latencyPromise: Promise<void> | null = null
  private readonly unsubscribers: Array<() => void> = []

  constructor(private readonly options: TrayControllerOptions) {
    this.unsubscribers.push(options.kernel.onStatus((status) => {
      this.status = status
      this.render()
    }))
    if (options.systemProxy) {
      this.unsubscribers.push(options.systemProxy.onStatus((status) => {
        this.systemProxyStatus = status
        this.render()
      }))
    }
    if (options.tun) {
      this.unsubscribers.push(options.tun.onStatus((status) => {
        this.tunStatus = status
        this.render()
      }))
    }
    this.unsubscribers.push(options.view.onActivate(options.showWindow))
    this.unsubscribers.push(options.view.onMenuOpen(() => this.refresh()))
    this.render()
  }

  async initialize(): Promise<void> {
    await this.refresh()
  }

  isReady(): boolean {
    return !this.disposed && this.options.view.isReady()
  }

  /** Pull every value that can also change outside the tray before it opens. */
  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.refreshInner().finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }

  private async refreshInner(): Promise<void> {
    if (this.disposed) return
    const [kernel, systemProxy, tun, profiles, groupOrder] = await Promise.all([
      Promise.resolve(this.options.kernel.getStatus()).catch(() => this.status),
      Promise.resolve(this.options.systemProxy?.getStatus()).catch(() => this.systemProxyStatus),
      Promise.resolve(this.options.tun?.getStatus()).catch(() => this.tunStatus),
      Promise.resolve(this.options.profiles?.listProfiles()).catch(() => this.profiles),
      Promise.resolve(this.options.resolveGroupOrder?.()).catch(() => this.groupOrder)
    ])
    this.status = kernel
    if (systemProxy) this.systemProxyStatus = systemProxy
    if (tun) this.tunStatus = tun
    if (profiles) this.profiles = profiles
    if (groupOrder) this.groupOrder = groupOrder

    if (kernel.phase === 'running' && this.options.mihomo) {
      const [config, proxies, connections] = await Promise.all([
        this.options.mihomo.getConfig().catch(() => null),
        this.options.mihomo.getProxies().catch(() => null),
        this.options.mihomo.getConnections().catch(() => null)
      ])
      if (config?.mode) this.mode = config.mode
      if (config) this.mixedPort = config['mixed-port'] ?? config.port ?? null
      if (proxies) this.proxies = proxies.proxies
      if (connections) this.connections = connections.connections
      this.refreshLatency()
    } else {
      this.proxies = {}
      this.connections = []
      this.networkLatencyMs = null
      this.mixedPort = null
    }
    this.render()
  }

  /** A network probe may take seconds; never hold the native menu or app startup open for it. */
  private refreshLatency(): void {
    if (!this.options.internetLatency || this.latencyPromise) return
    this.latencyPromise = this.options.internetLatency.sample()
      .then((sample) => {
        if (this.disposed || this.status.phase !== 'running') return
        this.networkLatencyMs = sample.proxyMs ?? sample.gatewayMs
        this.render()
      })
      .catch(() => {
        if (!this.disposed) {
          this.networkLatencyMs = null
          this.render()
        }
      })
      .finally(() => { this.latencyPromise = null })
  }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    this.render()
    try {
      await action()
      await this.refreshInner()
    } catch (error) {
      this.options.onError?.(error)
      this.status = await Promise.resolve(this.options.kernel.getStatus()).catch(() => this.status)
    } finally {
      this.busy = false
      this.render()
    }
  }

  private selectableGroups(): Array<[string, MihomoProxy]> {
    const order = new Map(this.groupOrder.map((name, index) => [name, index]))
    return Object.entries(this.proxies)
      .filter(([, proxy]) => SELECTABLE_GROUP_TYPES.has(proxy.type) && Array.isArray(proxy.all) && proxy.all.length > 0)
      .sort(([left], [right]) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER))
  }

  private modeMenu(transition: boolean): TrayMenuItem {
    return {
      id: 'outbound-mode',
      label: `出站模式 · ${MODE_LABEL[this.mode]}`,
      enabled: this.status.phase === 'running' && !transition,
      submenu: (Object.keys(MODE_LABEL) as OutboundMode[]).map((mode) => ({
        id: `outbound-mode:${mode}`,
        label: MODE_LABEL[mode],
        type: 'radio',
        checked: this.mode === mode,
        enabled: !transition,
        click: () => { void this.act(async () => { await this.options.mihomo?.patchConfig({ mode }) }) }
      }))
    }
  }

  private groupMenus(transition: boolean): TrayMenuItem[] {
    return this.selectableGroups().map(([groupName, proxy]) => {
      const selected = selectedMember(proxy)
      return {
        id: `group:${groupName}`,
        label: selected ? `${groupName} · ${selected}` : groupName,
        enabled: !transition,
        submenu: proxy.all!.map((member) => ({
          id: `group:${groupName}:${member}`,
          label: member,
          type: 'radio',
          checked: selected === member,
          enabled: !transition,
          click: () => { void this.act(async () => { await this.options.mihomo?.selectProxy(groupName, member) }) }
        }))
      }
    })
  }

  private processMenu(): TrayMenuItem {
    const rows = processRows(this.connections)
    return {
      id: 'processes',
      label: `进程与客户端 · ${this.connections.length} 个连接`,
      enabled: rows.length > 0,
      submenu: rows.map((row, index) => ({
        id: `process:${index}`,
        label: `${row.name} · ${formatBytes(row.bytes)}`,
        enabled: false
      }))
    }
  }

  private configurationMenu(transition: boolean): TrayMenuItem {
    const active = this.profiles.find((profile) => profile.active)
    const urlProfiles = this.profiles.filter((profile) => profile.source.type === 'url')
    const profileItems: TrayMenuItem[] = this.profiles.map((profile) => ({
      id: `profile:${profile.id}`,
      label: profile.name,
      type: 'radio',
      checked: profile.active,
      enabled: !transition,
      click: () => { void this.act(async () => { await this.options.profiles?.activateProfile(profile.id) }) }
    }))
    const submenu: TrayMenuItem[] = [
        {
          id: 'reload-config',
          label: '重新载入当前配置',
          enabled: Boolean(active && this.status.phase === 'running' && this.options.reloadConfig && !transition),
          click: () => { void this.act(async () => { await this.options.reloadConfig?.() }) }
        },
        {
          id: 'restart-kernel',
          label: this.status.phase === 'running' ? '重启内核' : '启动内核',
          enabled: !transition,
          click: () => { void this.act(async () => {
            if (this.status.phase === 'running') await this.options.restartKernel?.()
            else await this.options.kernel.start()
          }) }
        }
      ]
    if (profileItems.length > 0) submenu.push(
      { id: 'configuration-separator-1', type: 'separator' },
      ...profileItems
    )
    if (urlProfiles.length > 0) submenu.push(
      { id: 'configuration-separator-2', type: 'separator' },
      {
          id: 'update-active-profile',
          label: '更新当前订阅',
          enabled: Boolean(active?.source.type === 'url' && !transition),
          click: () => { void this.act(async () => { if (active) await this.options.profiles?.updateFromSource(active.id) }) }
      },
      {
          id: 'update-all-profiles',
          label: '更新全部订阅',
          enabled: urlProfiles.length > 0 && !transition,
          click: () => { void this.act(async () => {
            const results = await Promise.allSettled(
              urlProfiles.map((profile) => this.options.profiles!.updateFromSource(profile.id))
            )
            const failed = results.find((result) => result.status === 'rejected')
            if (failed?.status === 'rejected') throw failed.reason
          }) }
      }
    )
    return { id: 'configuration', label: '配置', submenu }
  }

  private directoryMenu(): TrayMenuItem {
    const open = (directory: TrayDirectory): void => {
      void Promise.resolve(this.options.openDirectory?.(directory)).catch((error) => this.options.onError?.(error))
    }
    return {
      id: 'open-directory',
      label: '打开目录',
      submenu: [
        { id: 'open-application-directory', label: '应用目录', click: () => open('application') },
        { id: 'open-working-directory', label: '工作目录', click: () => open('working') },
        { id: 'open-kernel-directory', label: '内核目录', click: () => open('kernel') },
        { id: 'open-log-directory', label: '日志目录', click: () => open('logs') }
      ]
    }
  }

  private render(): void {
    if (this.disposed) return
    const phase = this.status.phase
    const transition = phase === 'starting' || phase === 'stopping' || this.busy
    const systemProxyBusy = this.systemProxyStatus.phase === 'enabling' || this.systemProxyStatus.phase === 'restoring'
    const tunBusy = this.tunStatus.phase === 'starting' || this.tunStatus.phase === 'restoring'
    const mixedPort = this.mixedPort
    this.options.view.setToolTip(`${this.options.productName} · ${PHASE_LABEL[phase]}`)
    this.options.view.setMenu([
      { id: 'show', label: '显示主窗口', enabled: true, click: this.options.showWindow },
      { id: 'separator:top', type: 'separator' },
      this.modeMenu(transition),
      ...this.groupMenus(transition),
      { id: 'separator:runtime', type: 'separator' },
      { id: 'network-quality', label: `网络质量 · ${this.networkLatencyMs === null ? '—' : `${this.networkLatencyMs} ms`}`, enabled: false },
      this.processMenu(),
      { id: 'separator:controls', type: 'separator' },
      {
        id: 'system-proxy', label: '系统代理', type: 'checkbox', checked: this.systemProxyStatus.phase === 'enabled',
        enabled: this.systemProxyStatus.supported && !systemProxyBusy && !transition,
        click: () => { void this.act(async () => {
          if (this.systemProxyStatus.phase === 'enabled') await this.options.systemProxy?.disable()
          else {
            if (this.status.phase !== 'running' && this.tunStatus.phase !== 'active') await this.options.kernel.start()
            await this.options.systemProxy?.enable()
          }
        }) }
      },
      {
        id: 'tun', label: 'TUN 模式', type: 'checkbox', checked: this.tunStatus.phase === 'active',
        enabled: this.tunStatus.supported && !tunBusy && !transition,
        click: () => { void this.act(async () => {
          if (this.tunStatus.phase === 'active') await this.options.tun?.disable()
          else await this.options.tun?.enable()
        }) }
      },
      {
        id: 'copy-terminal-proxy', label: '复制终端代理命令',
        enabled: this.status.phase === 'running' && typeof mixedPort === 'number',
        click: () => {
          if (!mixedPort) return
          const endpoint = `127.0.0.1:${mixedPort}`
          this.options.copyText?.([
            `$env:HTTP_PROXY=\"http://${endpoint}\"`,
            '$env:HTTPS_PROXY=$env:HTTP_PROXY',
            `$env:ALL_PROXY=\"socks5://${endpoint}\"`
          ].join('\n'))
        }
      },
      { id: 'separator:management', type: 'separator' },
      this.configurationMenu(transition),
      this.directoryMenu(),
      { id: 'check-update', label: '检查更新', enabled: true, click: () => { void this.options.onCheckUpdate?.() } },
      { id: 'separator:quit', type: 'separator' },
      { id: 'quit', label: `退出 ${this.options.productName}`, enabled: true, click: this.options.quit }
    ])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.options.view.destroy()
  }
}
