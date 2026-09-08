import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FakeKernelGateway,
  FakeMihomoGateway,
  FakeProfileGateway,
  FakeSystemProxyGateway,
  FakeTunGateway
} from '../src/main/testing/fake-container'
import { TrayController, type TrayMenuItem, type TrayView } from '../src/main/tray/tray-controller'
import type { RuntimeAccent } from '../src/shared/runtime-accent'

class FakeTrayView implements TrayView {
  tooltip = ''
  menu: TrayMenuItem[] = []
  activate: (() => void) | null = null
  menuOpen: (() => Promise<void>) | null = null
  destroyed = false
  appearance: { accent: RuntimeAccent; dark: boolean } = { accent: 'idle', dark: false }
  isReady(): boolean { return !this.destroyed }
  setToolTip(value: string): void { this.tooltip = value }
  setMenu(items: TrayMenuItem[]): void { this.menu = items }
  setRuntimeAppearance(accent: RuntimeAccent, dark: boolean): void { this.appearance = { accent, dark } }
  onActivate(listener: () => void): () => void { this.activate = listener; return () => { this.activate = null } }
  onMenuOpen(listener: () => Promise<void>): () => void { this.menuOpen = listener; return () => { this.menuOpen = null } }
  destroy(): void { this.destroyed = true }
  item(id: string, items: TrayMenuItem[] = this.menu): TrayMenuItem | undefined {
    for (const item of items) {
      if (item.id === id) return item
      const nested = this.item(id, item.submenu ?? [])
      if (nested) return nested
    }
    return undefined
  }
}

describe('TrayController', () => {
  let kernel: FakeKernelGateway
  let mihomo: FakeMihomoGateway
  let profiles: FakeProfileGateway
  let systemProxy: FakeSystemProxyGateway
  let tun: FakeTunGateway
  let view: FakeTrayView
  const show = vi.fn()
  const quit = vi.fn()

  beforeEach(() => {
    kernel = new FakeKernelGateway()
    mihomo = new FakeMihomoGateway()
    profiles = new FakeProfileGateway()
    systemProxy = new FakeSystemProxyGateway()
    tun = new FakeTunGateway()
    view = new FakeTrayView()
    show.mockClear()
    quit.mockClear()
  })

  function create(extra: Record<string, unknown> = {}): TrayController {
    return new TrayController({
      productName: 'Configurable Name', kernel, mihomo, profiles, systemProxy, tun, view,
      showWindow: show, quit, ...extra
    })
  }

  it('renders the requested controls with product terminology and no unsupported sections', async () => {
    const controller = create()
    await controller.initialize()

    expect(view.item('show')?.label).toBe('显示主窗口')
    expect(view.item('system-proxy')?.label).toBe('系统代理')
    expect(view.item('tun')?.label).toBe('TUN 模式')
    expect(view.item('configuration')?.label).toBe('配置')
    expect(view.item('open-directory')?.label).toBe('打开目录')
    expect(view.item('open-log-directory')?.label).toBe('日志目录')
    expect(view.menu.flatMap((item) => [item.label, ...(item.submenu ?? []).map((entry) => entry.label)]))
      .not.toEqual(expect.arrayContaining(['Surge 面板', '远程面板', '功能', '模块', '设置为系统代理', '增强模式']))
    view.activate?.()
    expect(show).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('refreshes live groups before opening and delegates mode and node selection', async () => {
    kernel.status = { ...kernel.status, phase: 'running', pid: 42 }
    mihomo.config = { mode: 'rule', 'mixed-port': 7890 }
    mihomo.proxies = {
      proxies: {
        Telegram: { name: 'Telegram', type: 'Selector', now: 'Oracle', all: ['Oracle', 'DIRECT'] }
      }
    }
    const controller = create()
    await controller.initialize()
    await view.menuOpen?.()

    expect(view.item('outbound-mode')?.label).toBe('出站模式 · 规则')
    expect(view.item('group:Telegram')?.label).toBe('Telegram · Oracle')
    expect(view.item('group:Telegram:Oracle')?.checked).toBe(true)
    view.item('outbound-mode:global')?.click?.()
    await vi.waitFor(() => expect(mihomo.patchConfigCalls).toContainEqual({ mode: 'global' }))
    await view.menuOpen?.()
    view.item('group:Telegram:DIRECT')?.click?.()
    await vi.waitFor(() => expect(mihomo.selectProxyCalls).toContainEqual({ group: 'Telegram', name: 'DIRECT' }))
    controller.dispose()
  })

  it('shows a cached policy icon and refreshes it without blocking the native menu', async () => {
    kernel.status = { ...kernel.status, phase: 'running', pid: 42 }
    mihomo.proxies = {
      proxies: {
        AI: {
          name: 'AI', type: 'Selector', now: 'Oracle', all: ['Oracle'],
          icon: 'https://example.com/ai.png'
        }
      }
    }
    const cached = 'data:image/png;base64,Y2FjaGVk'
    const refreshed = 'data:image/png;base64,cmVmcmVzaGVk'
    const resolveGroupIcon = vi.fn(async (_key: string, url?: string) => url ? refreshed : cached)
    const controller = create({ resolveGroupIcon })
    await controller.initialize()

    await vi.waitFor(() => expect(view.item('group:AI')?.icon).toBe(refreshed))
    expect(resolveGroupIcon).toHaveBeenNthCalledWith(1, 'policy:AI')
    expect(resolveGroupIcon).toHaveBeenNthCalledWith(2, 'policy:AI', 'https://example.com/ai.png', true)
    controller.dispose()
  })

  it('auto-starts the kernel for system proxy and toggles TUN through their gateways', async () => {
    const controller = create()
    await controller.initialize()
    view.item('system-proxy')?.click?.()
    await vi.waitFor(() => expect(systemProxy.enableCalls).toBe(1))
    expect(kernel.startCalls).toBe(1)

    view.item('tun')?.click?.()
    await vi.waitFor(() => expect(tun.enableCalls).toBe(1))
    controller.dispose()
  })

  it('connects profile, directory and terminal-command actions to real callbacks', async () => {
    kernel.status = { ...kernel.status, phase: 'running', pid: 42 }
    mihomo.config = { mode: 'rule', 'mixed-port': 7890 }
    await profiles.importFromUrl('订阅配置', 'https://example.com/sub', true)
    const openDirectory = vi.fn()
    const copyText = vi.fn()
    const controller = create({ openDirectory, copyText })
    await controller.initialize()

    expect(view.item('profile:p1')?.checked).toBe(true)
    view.item('open-kernel-directory')?.click?.()
    expect(openDirectory).toHaveBeenCalledWith('kernel')
    view.item('open-log-directory')?.click?.()
    expect(openDirectory).toHaveBeenCalledWith('logs')
    view.item('copy-terminal-proxy')?.click?.()
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('127.0.0.1:7890'))
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('$env:HTTP_PROXY'))
    controller.dispose()
  })

  it('reacts to external status events and disposes native resources once', async () => {
    const controller = create()
    await controller.initialize()
    kernel.emitStatus({ ...kernel.status, phase: 'failed', lastError: 'boom' })
    expect(view.tooltip).toBe('Configurable Name · 启动失败')
    view.item('quit')?.click?.()
    expect(quit).toHaveBeenCalledOnce()
    controller.dispose(); controller.dispose()
    expect(controller.isReady()).toBe(false)
    expect(view.destroyed).toBe(true)
    expect(view.activate).toBeNull()
    expect(view.menuOpen).toBeNull()
  })
})
