import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeKernelGateway } from '../src/main/testing/fake-container'
import { TrayController, type TrayMenuItem, type TrayView } from '../src/main/tray/tray-controller'

class FakeTrayView implements TrayView {
  tooltip = ''
  menu: TrayMenuItem[] = []
  activate: (() => void) | null = null
  destroyed = false
  isReady(): boolean { return !this.destroyed }
  setToolTip(value: string): void { this.tooltip = value }
  setMenu(items: TrayMenuItem[]): void { this.menu = items }
  onActivate(listener: () => void): () => void { this.activate = listener; return () => { this.activate = null } }
  destroy(): void { this.destroyed = true }
  item(id: TrayMenuItem['id']): TrayMenuItem | undefined { return this.menu.find((item) => item.id === id) }
}

describe('TrayController', () => {
  let kernel: FakeKernelGateway
  let view: FakeTrayView
  const show = vi.fn()
  const quit = vi.fn()

  beforeEach(() => { kernel = new FakeKernelGateway(); view = new FakeTrayView(); show.mockClear(); quit.mockClear() })

  it('renders verified status and delegates activation to the window owner', async () => {
    kernel.status = { ...kernel.status, phase: 'running', pid: 42 }
    const controller = new TrayController({ productName: 'Configurable Name', kernel, view, showWindow: show, quit })
    await controller.initialize()
    expect(controller.isReady()).toBe(true)
    expect(view.tooltip).toBe('Configurable Name · 运行中')
    expect(view.item('start')?.enabled).toBe(false)
    expect(view.item('stop')?.enabled).toBe(true)
    view.activate?.()
    expect(show).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('serializes actions and waits for gateway results instead of toggling optimistically', async () => {
    let resolveStart: ((value: typeof kernel.status) => void) | undefined
    kernel.start = vi.fn(() => new Promise((resolve) => { resolveStart = resolve }))
    const controller = new TrayController({ productName: 'Test Product', kernel, view, showWindow: show, quit })
    await controller.initialize()
    view.item('start')?.click?.()
    view.item('start')?.click?.()
    expect(kernel.start).toHaveBeenCalledOnce()
    expect(view.item('start')?.enabled).toBe(false)
    resolveStart?.({ ...kernel.status, phase: 'running', pid: 77 })
    await Promise.resolve(); await Promise.resolve()
    expect(view.item('stop')?.enabled).toBe(true)
    controller.dispose()
  })

  it('reacts to external status events and disposes native resources once', async () => {
    const controller = new TrayController({ productName: 'Test Product', kernel, view, showWindow: show, quit })
    await controller.initialize()
    kernel.emitStatus({ ...kernel.status, phase: 'failed', lastError: 'boom' })
    expect(view.tooltip).toBe('Test Product · 启动失败')
    view.item('quit')?.click?.()
    expect(quit).toHaveBeenCalledOnce()
    controller.dispose(); controller.dispose()
    expect(controller.isReady()).toBe(false)
    expect(view.destroyed).toBe(true)
    expect(view.activate).toBeNull()
  })
})
