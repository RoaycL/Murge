import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../src/shared/app-settings'
import type { KernelStatus } from '../src/shared/runtime'
import type { SystemProxyStatus } from '../src/shared/system-proxy'
import type { TunStatus } from '../src/shared/tun'
import { restoreRuntimeIntent } from '../src/main/startup/runtime-intent'

const stoppedKernel = (): KernelStatus => ({
  phase: 'stopped',
  pid: null,
  version: null,
  controllerUrl: null,
  startedAt: null,
  lastError: null
})

const runningKernel = (): KernelStatus => ({
  ...stoppedKernel(),
  phase: 'running',
  pid: 42,
  controllerUrl: 'http://127.0.0.1:9090'
})

const tunStatus = (phase: TunStatus['phase']): TunStatus => ({
  supported: true,
  phase,
  errorMessage: null,
  conflictDetail: null,
  updatedAt: null
})

const proxyStatus = (phase: SystemProxyStatus['phase']): SystemProxyStatus => ({
  supported: true,
  phase,
  address: phase === 'enabled' ? '127.0.0.1:7889' : null,
  port: phase === 'enabled' ? 7889 : null,
  proxyOverride: null,
  errorMessage: null,
  conflictDetail: null,
  updatedAt: null
})

const settings = (patch: Partial<AppSettings>): AppSettings => ({
  ...DEFAULT_APP_SETTINGS,
  ...patch
})

describe('restoreRuntimeIntent', () => {
  it('restores kernel -> TUN (bounded retry) -> system proxy in dependency order', async () => {
    const order: string[] = []
    let kernel = stoppedKernel()
    let tun = tunStatus('configured')
    let proxy = proxyStatus('disabled')
    let tunAttempts = 0

    const result = await restoreRuntimeIntent(
      settings({ systemProxyDesired: true, tunDesired: true }),
      {
        kernel: {
          getStatus: async () => kernel,
          start: async () => {
            order.push('kernel')
            kernel = runningKernel()
            return kernel
          }
        },
        tun: {
          getStatus: async () => tun,
          enable: async () => {
            order.push('tun')
            tunAttempts += 1
            tun = tunStatus(tunAttempts === 3 ? 'active' : 'configured')
            return tun
          }
        },
        systemProxy: {
          getStatus: async () => proxy,
          enable: async () => {
            order.push('proxy')
            proxy = proxyStatus('enabled')
            return proxy
          }
        },
        restoreSelections: async () => {
          order.push('selections')
        },
        delay: async (ms) => {
          order.push(`delay:${ms}`)
        }
      }
    )

    expect(result.tun.phase).toBe('active')
    expect(result.systemProxyPhase).toBe('enabled')
    expect(order).toEqual([
      'kernel',
      'selections',
      'tun',
      'delay:750',
      'tun',
      'delay:1500',
      'tun',
      'selections',
      'proxy'
    ])
  })

  it('starts the required host even when ordinary kernel autostart is disabled', async () => {
    let kernel = stoppedKernel()
    const start = vi.fn(async () => {
      kernel = runningKernel()
      return kernel
    })

    await restoreRuntimeIntent(
      settings({ autoStartKernel: false, systemProxyDesired: true }),
      {
        kernel: { getStatus: async () => kernel, start },
        tun: { getStatus: async () => tunStatus('configured'), enable: vi.fn() },
        systemProxy: {
          getStatus: async () => proxyStatus('disabled'),
          enable: async () => proxyStatus('enabled')
        },
        delay: async () => undefined
      }
    )

    expect(start).toHaveBeenCalledOnce()
  })

  it('does not retry a TUN conflict or enable an unrequested takeover', async () => {
    const tunEnable = vi.fn(async () => tunStatus('active'))
    const proxyEnable = vi.fn(async () => proxyStatus('enabled'))

    const result = await restoreRuntimeIntent(
      settings({ autoStartKernel: false, tunDesired: true, systemProxyDesired: false }),
      {
        kernel: { getStatus: async () => runningKernel(), start: vi.fn() },
        tun: { getStatus: async () => tunStatus('conflict'), enable: tunEnable },
        systemProxy: { getStatus: async () => proxyStatus('disabled'), enable: proxyEnable },
        delay: async () => undefined
      }
    )

    expect(result.tun.phase).toBe('conflict')
    expect(tunEnable).not.toHaveBeenCalled()
    expect(proxyEnable).not.toHaveBeenCalled()
  })

  it('keeps existing installations inert when both durable intents are absent', async () => {
    const start = vi.fn(async () => runningKernel())
    const tunEnable = vi.fn(async () => tunStatus('active'))
    const proxyEnable = vi.fn(async () => proxyStatus('enabled'))

    await restoreRuntimeIntent(
      settings({ autoStartKernel: false }),
      {
        kernel: { getStatus: async () => stoppedKernel(), start },
        tun: { getStatus: async () => tunStatus('configured'), enable: tunEnable },
        systemProxy: { getStatus: async () => proxyStatus('disabled'), enable: proxyEnable },
        delay: async () => undefined
      }
    )

    expect(start).not.toHaveBeenCalled()
    expect(tunEnable).not.toHaveBeenCalled()
    expect(proxyEnable).not.toHaveBeenCalled()
  })
})
