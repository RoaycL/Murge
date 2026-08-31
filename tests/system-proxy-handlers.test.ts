import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { brand } from '@shared/brand'
import { ProtocolError, ProtocolErrorCode, decodeProtocolError } from '@shared/protocol-errors'
import { buildIpcHandlers } from '../src/main/ipc/handlers'
import { createFakeContainer } from '../src/main/testing/fake-container'
import { registerIpc } from '../src/main/ipc/register-ipc'
import type { SystemProxyStatus } from '@shared/system-proxy'

describe('buildIpcHandlers — system-proxy channels', () => {
  let container: ReturnType<typeof createFakeContainer>
  let handlers: ReturnType<typeof buildIpcHandlers>

  beforeEach(() => {
    container = createFakeContainer(brand)
    handlers = buildIpcHandlers(container.deps)
  })

  it('forwards get-status to the gateway', async () => {
    const result = await handlers[IPC.systemProxyGetStatus](null)
    expect(result).toEqual(container.systemProxy.status)
    expect(container.systemProxy.getStatusCalls).toBe(1)
  })

  it('forwards enable and returns the gateway status', async () => {
    container.systemProxy.emitStatus({
      supported: true,
      phase: 'enabled',
      address: '127.0.0.1:7890',
      port: 7890,
      errorMessage: null,
      conflictDetail: null,
      updatedAt: '2024-01-01T00:00:00.000Z'
    } as SystemProxyStatus)
    const result = await handlers[IPC.systemProxyEnable](null)
    expect(container.systemProxy.enableCalls).toBe(1)
    expect(result.phase).toBe('enabled')
  })

  it('forwards disable to the gateway', async () => {
    await handlers[IPC.systemProxyDisable](null)
    expect(container.systemProxy.disableCalls).toBe(1)
  })

  it('propagates a typed enable error WITHOUT re-encoding at the handler layer', async () => {
    container.systemProxy.enableError = new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核未运行')
    await expect(handlers[IPC.systemProxyEnable](null)).rejects.toMatchObject({
      code: ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED
    })
  })

  it('propagates a typed disable error', async () => {
    container.systemProxy.disableError = new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '恢复失败')
    await expect(handlers[IPC.systemProxyDisable](null)).rejects.toMatchObject({
      code: ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED
    })
  })
})

describe('registerIpc — system-proxy event & error wiring', () => {
  const { mockHandlers, mockWindows } = vi.hoisted(() => ({
    mockHandlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
    mockWindows: [] as { webContents: { send: ReturnType<typeof vi.fn> } }[]
  }))

  vi.mock('electron', () => ({
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
        mockHandlers.set(channel, fn)
      },
      removeHandler: (channel: string) => {
        mockHandlers.delete(channel)
      }
    },
    BrowserWindow: {
      getAllWindows: () => mockWindows
    },
    app: { getVersion: () => '0.0.0-test' }
  }))

  let container: ReturnType<typeof createFakeContainer>
  let dispose: () => void

  beforeEach(() => {
    mockWindows.length = 0
    container = createFakeContainer(brand)
    dispose = registerIpc({
      kernel: container.kernel,
      mihomo: container.mihomo,
      profiles: container.profiles,
      systemProxy: container.systemProxy,
      startup: container.startup,
      tun: container.tun
    })
  })

  it('registers the system-proxy invoke handlers', () => {
    expect(mockHandlers.has(IPC.systemProxyGetStatus)).toBe(true)
    expect(mockHandlers.has(IPC.systemProxyEnable)).toBe(true)
    expect(mockHandlers.has(IPC.systemProxyDisable)).toBe(true)
  })

  it('forwards status transitions to every open window', () => {
    const win = { webContents: { send: vi.fn() } }
    mockWindows.push(win as never)
    container.systemProxy.emitStatus({
      supported: true,
      phase: 'enabled',
      address: '127.0.0.1:7890',
      port: 7890,
      errorMessage: null,
      conflictDetail: null,
      updatedAt: ''
    } as SystemProxyStatus)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.systemProxyStatusEvent, expect.objectContaining({ phase: 'enabled' }))
  })

  it('stops forwarding after dispose', () => {
    const win = { webContents: { send: vi.fn() } }
    mockWindows.push(win as never)
    dispose()
    container.systemProxy.emitStatus({ supported: true, phase: 'enabled' } as SystemProxyStatus)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('encodes a typed error as a cross-process message on the wire', async () => {
    container.systemProxy.enableError = new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核未运行')
    const fn = mockHandlers.get(IPC.systemProxyEnable)!
    const err: unknown = await fn(null).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(decodeProtocolError((err as Error).message)).toMatchObject({
      code: ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED
    })
  })
})
