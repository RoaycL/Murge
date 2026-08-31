import type { KernelGateway } from '@shared/gateways'
import type { KernelStatus } from '@shared/runtime'

export interface TrayMenuItem {
  id: 'show' | 'status' | 'start' | 'stop' | 'check-update' | 'quit' | 'separator'
  label?: string
  enabled?: boolean
  type?: 'separator'
  click?: () => void
}

export interface TrayView {
  isReady(): boolean
  setToolTip(value: string): void
  setMenu(items: TrayMenuItem[]): void
  onActivate(listener: () => void): () => void
  destroy(): void
}

export interface TrayControllerOptions {
  productName: string
  kernel: KernelGateway
  view: TrayView
  showWindow(): void
  quit(): void
  onCheckUpdate?(): void
  onError?(error: unknown): void
}

const PHASE_LABEL: Record<KernelStatus['phase'], string> = {
  stopped: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止', failed: '启动失败'
}

/** Main-process tray state owner. No renderer state is trusted or mirrored optimistically. */
export class TrayController {
  private status: KernelStatus = { phase: 'stopped', pid: null, version: null, controllerUrl: null, startedAt: null, lastError: null }
  private busy = false
  private disposed = false
  private readonly unsubscribeStatus: () => void
  private readonly unsubscribeActivate: () => void

  constructor(private readonly options: TrayControllerOptions) {
    this.unsubscribeStatus = options.kernel.onStatus((status) => {
      this.status = status
      this.render()
    })
    this.unsubscribeActivate = options.view.onActivate(options.showWindow)
    this.render()
  }

  async initialize(): Promise<void> {
    this.status = await this.options.kernel.getStatus()
    this.render()
  }

  isReady(): boolean {
    return !this.disposed && this.options.view.isReady()
  }

  private async act(action: 'start' | 'stop'): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    this.render()
    try {
      this.status = await this.options.kernel[action]()
    } catch (error) {
      this.options.onError?.(error)
      this.status = await Promise.resolve(this.options.kernel.getStatus()).catch(() => this.status)
    } finally {
      this.busy = false
      this.render()
    }
  }

  private render(): void {
    if (this.disposed) return
    const phase = this.status.phase
    const transition = phase === 'starting' || phase === 'stopping' || this.busy
    this.options.view.setToolTip(`${this.options.productName} · ${PHASE_LABEL[phase]}`)
    this.options.view.setMenu([
      { id: 'show', label: `打开 ${this.options.productName}`, enabled: true, click: this.options.showWindow },
      { id: 'status', label: `内核：${PHASE_LABEL[phase]}`, enabled: false },
      { id: 'separator', type: 'separator' },
      { id: 'start', label: '启动内核', enabled: !transition && phase !== 'running', click: () => { void this.act('start') } },
      { id: 'stop', label: '停止内核', enabled: !transition && phase === 'running', click: () => { void this.act('stop') } },
      { id: 'check-update', label: '检查更新', enabled: true, click: () => { void this.options.onCheckUpdate?.() } },
      { id: 'separator', type: 'separator' },
      { id: 'quit', label: `退出 ${this.options.productName}`, enabled: true, click: this.options.quit }
    ])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeStatus()
    this.unsubscribeActivate()
    this.options.view.destroy()
  }
}
