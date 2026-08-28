import { ProtocolError, ProtocolErrorCode } from '../../../shared/protocol-errors'
import type { SystemProxyAdapter, SystemProxyRegistryState, SystemProxyWrittenState } from '../types'

const ABSENT: SystemProxyRegistryState = {
  proxyEnable: { exists: false, type: 'none', value: null },
  proxyServer: { exists: false, type: 'none', value: null },
  proxyOverride: { exists: false, type: 'none', value: null }
}

function unsupported(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_UNSUPPORTED, message)
}

/**
 * Fail-closed adapter for platforms that cannot own the system proxy (anything
 * but Windows). Every mutating operation reports `SYSTEM_PROXY_UNSUPPORTED`, so a
 * build that silently runs on a non-Windows host can never touch network settings.
 */
export class DisabledSystemProxyAdapter implements SystemProxyAdapter {
  supported = false

  constructor(readonly platform: string) {}

  read(): Promise<SystemProxyRegistryState> {
    // Reading is harmless: it returns an all-absent snapshot and never mutates.
    return Promise.resolve(ABSENT)
  }

  apply(_written: SystemProxyWrittenState): Promise<void> {
    throw unsupported(`当前平台（${this.platform}）不支持系统代理`)
  }

  restore(_previous: SystemProxyRegistryState): Promise<void> {
    throw unsupported(`当前平台（${this.platform}）不支持系统代理`)
  }

  refresh(): Promise<void> {
    throw unsupported(`当前平台（${this.platform}）不支持系统代理`)
  }
}
