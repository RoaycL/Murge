import { SYSTEM_PROXY_LOOPBACK_HOST, SystemProxyTarget } from '../../shared/system-proxy'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { KernelGateway } from '../../shared/gateways'
import type { MihomoConfigSnapshot } from '../../shared/mihomo-api'
import type { SystemProxyKernelProbe } from './types'

/** A probe that always returns a fixed target — used in dev and in unit tests. */
export class StaticSystemProxyProbe implements SystemProxyKernelProbe {
  constructor(private readonly target: SystemProxyTarget = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }) {}

  resolveTarget(): Promise<SystemProxyTarget> {
    return Promise.resolve(this.target)
  }
}

/** Minimal authenticated surface the live probe needs from the mihomo gateway. */
export interface LiveProbeMihomo {
  getVersion(): Promise<unknown>
  getConfig(): Promise<MihomoConfigSnapshot>
}

/**
 * Production probe: the system proxy may only be enabled once the kernel is
 * actually running, authenticated, and advertising a mixed-port. It never trusts
 * a hard-coded port — the port is read from the live `/configs` response.
 */
export class LiveSystemProxyKernelProbe implements SystemProxyKernelProbe {
  constructor(
    private readonly kernel: KernelGateway,
    private readonly mihomo: LiveProbeMihomo
  ) {}

  async resolveTarget(): Promise<SystemProxyTarget> {
    const status = await this.kernel.getStatus()
    if (status.phase !== 'running') {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核未运行，无法启用系统代理')
    }
    try {
      await this.mihomo.getVersion()
    } catch {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核控制器未就绪，无法启用系统代理')
    }
    const config = await this.mihomo.getConfig()
    const mixedPort = config['mixed-port']
    if (typeof mixedPort !== 'number' || !Number.isInteger(mixedPort) || mixedPort <= 0 || mixedPort > 65535) {
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核未提供有效的混合端口，无法启用系统代理')
    }
    return { host: SYSTEM_PROXY_LOOPBACK_HOST, port: mixedPort }
  }
}
