import { ProtocolError, ProtocolErrorCode } from '../../../shared/protocol-errors'
import type {
  RegistryValue,
  SystemProxyAdapter,
  SystemProxyRegistryState,
  SystemProxyWrittenState
} from '../types'

export type FakeApplyBehavior = 'write' | 'reject' | 'write-other' | 'partial'
export type FakeRestoreBehavior = 'restore' | 'reject' | 'restore-mismatch'
export type FakeRefreshBehavior = 'refresh' | 'reject'

export interface FakeSystemProxyAdapterOptions {
  /** Default true. When false, `apply` reports unsupported. */
  supported?: boolean
  /** Pre-enable registry snapshot the adapter starts from. */
  initial?: Partial<SystemProxyRegistryState>
  /** What `apply` does (default `write`). `write-other` produces a read-back mismatch. */
  applyBehavior?: FakeApplyBehavior
  /** What `restore` does (default `restore`). */
  restoreBehavior?: FakeRestoreBehavior
  /** What `refresh` does (default `refresh`). */
  refreshBehavior?: FakeRefreshBehavior
}

export type FakeSystemProxyCall =
  | { op: 'read' }
  | { op: 'apply'; written: SystemProxyWrittenState }
  | { op: 'restore'; previous: SystemProxyRegistryState }
  | { op: 'refresh' }
  | { op: 'mutate'; keys: (keyof SystemProxyRegistryState)[] }

const ABSENT: RegistryValue = { exists: false, type: 'none', value: null }

/**
 * In-memory registry stand-in for unit tests, the Mac dev box and static checks.
 *
 * `apply`/`restore` mutate an internal key map much like `reg.exe` would on
 * Windows, and every call is recorded so tests can assert ordering and rollback.
 * It never touches a real registry, so it is safe to drive from the handler /
 * service unit tests and from a dev build.
 */
export class FakeSystemProxyAdapter implements SystemProxyAdapter {
  readonly platform = 'fake'
  readonly supported: boolean
  readonly calls: FakeSystemProxyCall[] = []

  private keys: SystemProxyRegistryState
  private applyBehavior: FakeApplyBehavior
  private restoreBehavior: FakeRestoreBehavior
  private refreshBehavior: FakeRefreshBehavior

  constructor(options: FakeSystemProxyAdapterOptions = {}) {
    this.supported = options.supported ?? true
    this.applyBehavior = options.applyBehavior ?? 'write'
    this.restoreBehavior = options.restoreBehavior ?? 'restore'
    this.refreshBehavior = options.refreshBehavior ?? 'refresh'
    this.keys = {
      proxyEnable: options.initial?.proxyEnable ?? { ...ABSENT },
      proxyServer: options.initial?.proxyServer ?? { ...ABSENT },
      proxyOverride: options.initial?.proxyOverride ?? { ...ABSENT }
    }
  }

  read(): Promise<SystemProxyRegistryState> {
    this.calls.push({ op: 'read' })
    return Promise.resolve({ ...this.keys })
  }

  apply(written: SystemProxyWrittenState): Promise<void> {
    this.calls.push({ op: 'apply', written })
    if (!this.supported) {
      return Promise.reject(new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_UNSUPPORTED, '当前平台不支持系统代理'))
    }
    if (this.applyBehavior === 'reject') {
      return Promise.reject(new Error('simulated apply failure'))
    }
    if (this.applyBehavior === 'partial') {
      // Simulate a mid-apply failure: a subset is written, the rest is not, then
      // the command fails. This matches a `reg add` sequence that dies part-way.
      this.keys = {
        proxyEnable: { ...written.proxyEnable },
        proxyServer: { ...written.proxyServer },
        proxyOverride: { ...this.keys.proxyOverride }
      }
      return Promise.reject(new Error('simulated partial apply failure'))
    }
    if (this.applyBehavior === 'write-other') {
      this.keys = {
        proxyEnable: written.proxyEnable,
        proxyServer: { exists: true, type: 'REG_SZ', value: 'http=127.0.0.1:1;https=127.0.0.1:1;socks=127.0.0.1:1' },
        proxyOverride: written.proxyOverride
      }
      return Promise.resolve()
    }
    this.keys = {
      proxyEnable: { ...written.proxyEnable },
      proxyServer: { ...written.proxyServer },
      proxyOverride: { ...written.proxyOverride }
    }
    return Promise.resolve()
  }

  restore(previous: SystemProxyRegistryState): Promise<void> {
    this.calls.push({ op: 'restore', previous })
    if (this.restoreBehavior === 'reject') {
      return Promise.reject(new Error('simulated restore failure'))
    }
    if (this.restoreBehavior === 'restore-mismatch') {
      // Simulate a restore that writes the wrong value, so the read-back
      // verification cannot prove the operation succeeded.
      this.keys = {
        proxyEnable: { ...previous.proxyEnable },
        proxyServer: { exists: true, type: 'REG_SZ', value: 'http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9' },
        proxyOverride: { ...previous.proxyOverride }
      }
      return Promise.resolve()
    }
    this.keys = { ...previous }
    return Promise.resolve()
  }

  refresh(): Promise<void> {
    this.calls.push({ op: 'refresh' })
    if (this.refreshBehavior === 'reject') {
      return Promise.reject(new Error('simulated refresh failure'))
    }
    return Promise.resolve()
  }

  /** Simulate the OS / another process changing a key after a write. */
  mutate(partial: Partial<SystemProxyRegistryState>): void {
    const keys: (keyof SystemProxyRegistryState)[] = []
    if (partial.proxyEnable) {
      this.keys.proxyEnable = { ...partial.proxyEnable }
      keys.push('proxyEnable')
    }
    if (partial.proxyServer) {
      this.keys.proxyServer = { ...partial.proxyServer }
      keys.push('proxyServer')
    }
    if (partial.proxyOverride) {
      this.keys.proxyOverride = { ...partial.proxyOverride }
      keys.push('proxyOverride')
    }
    this.calls.push({ op: 'mutate', keys })
  }
}
