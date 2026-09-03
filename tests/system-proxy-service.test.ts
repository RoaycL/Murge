import { describe, it, expect } from 'vitest'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import { SYSTEM_PROXY_LOOPBACK_HOST } from '@shared/system-proxy'
import { SystemProxyService } from '../src/main/system-proxy/service'
import { StaticSystemProxyProbe } from '../src/main/system-proxy/probe'
import { FakeSystemProxyAdapter } from '../src/main/system-proxy/adapters/fake-adapter'
import { InMemorySystemProxyBackupStore } from '../src/main/system-proxy/backup-store'
import type {
  SystemProxyAdapter,
  SystemProxyBackup,
  SystemProxyBackupStore,
  SystemProxyKernelProbe,
  SystemProxyRegistryState,
  SystemProxyStatus,
  SystemProxyTarget,
  SystemProxyWrittenState
} from '../src/main/system-proxy/types'

const TARGET: SystemProxyTarget = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7890 }
const NEXT_TARGET: SystemProxyTarget = { host: SYSTEM_PROXY_LOOPBACK_HOST, port: 7891 }

class ConfigurableProbe implements SystemProxyKernelProbe {
  constructor(private readonly behavior: () => Promise<SystemProxyTarget>) {}
  resolveTarget(): Promise<SystemProxyTarget> {
    return this.behavior()
  }
}

class ThrowingBackupStore implements SystemProxyBackupStore {
  read(): Promise<never> {
    return Promise.reject(new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '损坏的备份'))
  }
  write(): Promise<void> {
    return Promise.resolve()
  }
  delete(): Promise<void> {
    return Promise.resolve()
  }
}

const kernelRequired = (): Promise<SystemProxyTarget> =>
  Promise.reject(new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '内核未运行'))

/** Adapter whose registry `read()` always fails — used to prove fail-closed ordering. */
class ReadThrowingAdapter implements SystemProxyAdapter {
  readonly platform = 'fake'
  readonly supported = true
  readonly delegate = new FakeSystemProxyAdapter()
  read(): Promise<SystemProxyRegistryState> {
    return Promise.reject(new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, '读取注册表值失败'))
  }
  apply(written: SystemProxyWrittenState): Promise<void> {
    return this.delegate.apply(written)
  }
  restore(previous: SystemProxyRegistryState): Promise<void> {
    return this.delegate.restore(previous)
  }
  refresh(): Promise<void> {
    return this.delegate.refresh()
  }
}

/** Backup store that records whether `write` was ever reached. */
class RecordingBackupStore implements SystemProxyBackupStore {
  writeCalls = 0
  read(): Promise<SystemProxyBackup | null> {
    return Promise.resolve(null)
  }
  write(): Promise<void> {
    this.writeCalls += 1
    return Promise.resolve()
  }
  delete(): Promise<void> {
    return Promise.resolve()
  }
}

interface MakeOptions {
  supported?: boolean
  applyBehavior?: 'write' | 'reject' | 'write-other' | 'partial'
  restoreBehavior?: 'restore' | 'reject' | 'restore-mismatch'
  refreshBehavior?: 'refresh' | 'reject'
  initial?: ConstructorParameters<typeof FakeSystemProxyAdapter>[0]['initial']
  probe?: SystemProxyKernelProbe
  backup?: SystemProxyBackupStore
}

function makeService(options: MakeOptions = {}) {
  const adapter = new FakeSystemProxyAdapter({
    supported: options.supported,
    applyBehavior: options.applyBehavior,
    restoreBehavior: options.restoreBehavior,
    refreshBehavior: options.refreshBehavior,
    initial: options.initial
  })
  const backup = options.backup ?? new InMemorySystemProxyBackupStore()
  const probe = options.probe ?? new StaticSystemProxyProbe(TARGET)
  const service = new SystemProxyService({ adapter, probe, backup, instanceId: 'test-instance' })
  return { service, adapter, backup }
}

const expectReject = (promise: Promise<unknown>, code: ProtocolErrorCode) =>
  expect(promise).rejects.toMatchObject({ code })

describe('SystemProxyService', () => {
  describe('construction & status', () => {
    it('starts disabled on a supported adapter', () => {
      const { service } = makeService()
      expect(service.getStatus().phase).toBe('disabled')
      expect(service.getStatus().supported).toBe(true)
    })

    it('starts unsupported on a non-supported adapter', () => {
      const { service } = makeService({ supported: false })
      expect(service.getStatus().phase).toBe('unsupported')
      expect(service.getStatus().supported).toBe(false)
    })

    it('onStatus reports transitions', async () => {
      const { service } = makeService()
      const seen: string[] = []
      service.onStatus((s: SystemProxyStatus) => seen.push(s.phase))
      await service.enable()
      expect(seen).toContain('enabling')
      expect(seen[seen.length - 1]).toBe('enabled')
    })
  })

  describe('enable', () => {
    it('enables the proxy and reports the live target', async () => {
      const { service } = makeService()
      const status = await service.enable()
      expect(status.phase).toBe('enabled')
      expect(status.address).toBe('127.0.0.1:7890')
      expect(status.port).toBe(7890)
    })

    it('writes the backup BEFORE applying and keeps it on success', async () => {
      const { service, adapter, backup } = makeService()
      await service.enable()
      await expect(backup.read()).resolves.not.toBeNull()
      const ops = adapter.calls.map((c) => c.op)
      expect(ops).toEqual(['read', 'apply', 'refresh', 'read'])
    })

    it('is idempotent: an already-owned proxy is re-enabled without re-applying', async () => {
      const { service, adapter } = makeService()
      await service.enable()
      const applyCount = adapter.calls.filter((c) => c.op === 'apply').length
      await service.enable()
      expect(adapter.calls.filter((c) => c.op === 'apply').length).toBe(applyCount)
    })

    it('throws unsupported and stays unsupported when the adapter is not supported', async () => {
      const { service } = makeService({ supported: false })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_UNSUPPORTED)
      expect(service.getStatus().phase).toBe('unsupported')
    })

    it('throws kernel-required and stays disabled when the kernel is not running', async () => {
      const { service } = makeService({ probe: new ConfigurableProbe(kernelRequired) })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED)
      expect(service.getStatus().phase).toBe('disabled')
      expect(service.getStatus().errorMessage).toBe('请先启动内核')
    })

    it('aborts before any backup.write or apply when the pre-enable registry read fails (P1 fail-closed)', async () => {
      // A fail-closed registry reader must surface a read failure, so enable() can
      // never observe a phantom "all absent" snapshot and must not back it up or
      // write it — otherwise a real unreadable value could be deleted on restore.
      const adapter = new ReadThrowingAdapter()
      const backup = new RecordingBackupStore()
      const service = new SystemProxyService({
        adapter,
        probe: new StaticSystemProxyProbe(TARGET),
        backup,
        instanceId: 'test-instance'
      })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED)
      expect(backup.writeCalls).toBe(0)
      expect(adapter.delegate.calls.some((c) => c.op === 'apply')).toBe(false)
    })

    it('throws state-conflict and does not apply when an owned backup was mutated externally', async () => {
      const { service, adapter, backup } = makeService()
      await service.enable()
      adapter.mutate({ proxyServer: { exists: true, type: 'REG_SZ', value: 'http=1.2.3.4:5' } })
      const applyCount = adapter.calls.filter((c) => c.op === 'apply').length
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_STATE_CONFLICT)
      expect(adapter.calls.filter((c) => c.op === 'apply').length).toBe(applyCount)
      expect(service.getStatus().phase).toBe('conflict')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('re-adopts a stale bundle whose unified port moved across sessions instead of conflicting', async () => {
      // A previous session enabled the proxy at port 7890 and left an owned
      // bundle on disk; this session allocated a fresh (unified) port 7891. The
      // registry still points at our write, so this is OUR stale bundle — enabling
      // must restore the true pre-enable state and re-enable fresh at the new
      // port, never surface an external-modification conflict.
      const adapter = new FakeSystemProxyAdapter()
      const backup = new InMemorySystemProxyBackupStore()
      const first = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'owner' })
      await first.enable()
      const restoreCallsBefore = adapter.calls.filter((c) => c.op === 'restore').length

      const next = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(NEXT_TARGET), backup, instanceId: 'owner' })
      const status = await next.enable()
      expect(status.phase).toBe('enabled')
      expect(status.port).toBe(NEXT_TARGET.port)
      // The stale write was rolled back to the pre-enable state before re-enabling.
      expect(adapter.calls.filter((c) => c.op === 'restore').length).toBeGreaterThan(restoreCallsBefore)
      // A fresh bundle now targets the current live port.
      const bundle = await backup.read()
      expect(bundle).not.toBeNull()
      expect(bundle!.target.port).toBe(NEXT_TARGET.port)
    })

    it('still conflicts when a stale-target bundle was mutated externally (route not ours)', async () => {
      // Same cross-session port move, but the registry proxy was replaced by a
      // non-loopback host: that is a genuine external takeover, not our stale
      // write, so it must stay a conflict.
      const adapter = new FakeSystemProxyAdapter()
      const backup = new InMemorySystemProxyBackupStore()
      const first = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'owner' })
      await first.enable()
      adapter.mutate({ proxyServer: { exists: true, type: 'REG_SZ', value: 'http=8.8.8.8:8080' } })

      const next = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(NEXT_TARGET), backup, instanceId: 'owner' })
      await expectReject(next.enable(), ProtocolErrorCode.SYSTEM_PROXY_STATE_CONFLICT)
      expect(next.getStatus().phase).toBe('conflict')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('rolls back to disabled and clears the backup when apply fails', async () => {
      const { service, backup } = makeService({ applyBehavior: 'reject' })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED)
      expect(service.getStatus().phase).toBe('disabled')
      await expect(backup.read()).resolves.toBeNull()
    })

    it('rolls back and clears the backup on a read-back mismatch', async () => {
      const { service, adapter, backup } = makeService({ applyBehavior: 'write-other' })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED)
      expect(service.getStatus().phase).toBe('disabled')
      expect(adapter.calls.some((c) => c.op === 'restore')).toBe(true)
      await expect(backup.read()).resolves.toBeNull()
    })

    it('rejects a target that is not loopback', async () => {
      const { service } = makeService({
        probe: new ConfigurableProbe(() => Promise.resolve({ host: '0.0.0.0', port: 7890 }))
      })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED)
      expect(service.getStatus().phase).toBe('disabled')
    })

    it('refuses to enable BEFORE writing anything when a previous value is unrestorable', async () => {
      const { service, adapter, backup } = makeService({
        initial: { proxyServer: { exists: true, type: 'REG_MULTI_SZ', value: 'a;b' } }
      })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED)
      // No apply was attempted and no backup was persisted — nothing was mutated.
      expect(adapter.calls.some((c) => c.op === 'apply')).toBe(false)
      await expect(backup.read()).resolves.toBeNull()
      expect(service.getStatus().phase).toBe('disabled')
    })

    it('still enforces a confirmed rollback: partial apply + restore failure keeps the backup', async () => {
      const { service, backup } = makeService({ applyBehavior: 'partial', restoreBehavior: 'reject' })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED)
      expect(service.getStatus().phase).toBe('restore-failed')
      expect(service.getStatus().errorMessage).toBe('系统代理启用失败且无法还原，已保留备份')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('keeps the backup and flags restore-failed when refresh fails during rollback', async () => {
      const { service, backup } = makeService({ refreshBehavior: 'reject' })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED)
      expect(service.getStatus().phase).toBe('restore-failed')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('keeps the backup and flags restore-failed when a read-back mismatch cannot be proven', async () => {
      const { service, backup } = makeService({ applyBehavior: 'write-other', restoreBehavior: 'restore-mismatch' })
      await expectReject(service.enable(), ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED)
      expect(service.getStatus().phase).toBe('restore-failed')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('accepts a restoreable REG_EXPAND_SZ previous value and enables cleanly', async () => {
      const { service, backup } = makeService({
        initial: { proxyServer: { exists: true, type: 'REG_EXPAND_SZ', value: '%PROGRAMFILES%\\proxy' } }
      })
      const status = await service.enable()
      expect(status.phase).toBe('enabled')
      await expect(backup.read()).resolves.not.toBeNull()
    })
  })

  describe('disable (ownership-aware)', () => {
    it('is a no-op when nothing is owned', async () => {
      const { service, adapter } = makeService()
      const status = await service.disable()
      expect(status.phase).toBe('disabled')
      expect(adapter.calls.some((c) => c.op === 'restore')).toBe(false)
    })

    it('restores the pre-enable snapshot and clears the backup', async () => {
      const { service, adapter, backup } = makeService({
        initial: { proxyEnable: { exists: true, type: 'REG_DWORD', value: 0 } }
      })
      await service.enable()
      const status = await service.disable()
      expect(status.phase).toBe('disabled')
      await expect(backup.read()).resolves.toBeNull()
      expect(adapter.calls.some((c) => c.op === 'restore')).toBe(true)
      expect(adapter.calls.some((c) => c.op === 'refresh')).toBe(true)
    })

    it('throws state-conflict and keeps the backup when the proxy was mutated externally', async () => {
      const { service, adapter, backup } = makeService()
      await service.enable()
      adapter.mutate({ proxyServer: { exists: true, type: 'REG_SZ', value: 'http=9.9.9.9:1' } })
      await expectReject(service.disable(), ProtocolErrorCode.SYSTEM_PROXY_STATE_CONFLICT)
      expect(service.getStatus().phase).toBe('conflict')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('flags restore-failed and keeps the backup when restore throws', async () => {
      const { service, backup } = makeService({ restoreBehavior: 'reject' })
      await service.enable()
      await expectReject(service.disable(), ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED)
      expect(service.getStatus().phase).toBe('restore-failed')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('throws unsupported when the adapter is not supported', async () => {
      const { service } = makeService({ supported: false })
      await expectReject(service.disable(), ProtocolErrorCode.SYSTEM_PROXY_UNSUPPORTED)
    })

    it('fails closed when the backup is corrupt', async () => {
      const { service } = makeService({ backup: new ThrowingBackupStore() })
      await expectReject(service.disable(), ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED)
    })
  })

  describe('restoreBeforeKernelUnavailable', () => {
    it('restores an owned proxy and clears the backup', async () => {
      const { service, backup } = makeService()
      await service.enable()
      await service.restoreBeforeKernelUnavailable()
      expect(service.getStatus().phase).toBe('disabled')
      await expect(backup.read()).resolves.toBeNull()
    })

    it('treats a conflict as safe and reports it (no registry mutation)', async () => {
      const { service, adapter, backup } = makeService()
      await service.enable()
      adapter.mutate({ proxyServer: { exists: true, type: 'REG_SZ', value: 'http=5.5.5.5:1' } })
      await expect(service.restoreBeforeKernelUnavailable()).resolves.toBeUndefined()
      expect(service.getStatus().phase).toBe('conflict')
      expect(adapter.calls.some((c) => c.op === 'restore')).toBe(false)
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('throws and flags restore-failed when a restore genuinely fails', async () => {
      const { service, backup } = makeService({ restoreBehavior: 'reject' })
      await service.enable()
      await expectReject(service.restoreBeforeKernelUnavailable(), ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED)
      expect(service.getStatus().phase).toBe('restore-failed')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('is a no-op when nothing is owned', async () => {
      const { service } = makeService()
      await expect(service.restoreBeforeKernelUnavailable()).resolves.toBeUndefined()
      expect(service.getStatus().phase).toBe('disabled')
    })
  })

  describe('init (startup orphan recovery)', () => {
    it('is a no-op on an unsupported adapter', async () => {
      const { service } = makeService({ supported: false })
      const status = await service.init()
      expect(status.phase).toBe('unsupported')
    })

    it('is a no-op when no backup exists', async () => {
      const { service } = makeService()
      const status = await service.init()
      expect(status.phase).toBe('disabled')
    })

    it('restores an orphan owned backup left by a crash', async () => {
      const adapter = new FakeSystemProxyAdapter()
      const backup = new InMemorySystemProxyBackupStore()
      const first = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'owner' })
      await first.enable() // leaves the owned bundle + applied values
      const next = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'growth-2' })
      const status = await next.init()
      expect(status.phase).toBe('disabled')
      await expect(backup.read()).resolves.toBeNull()
      expect(adapter.calls.some((c) => c.op === 'restore')).toBe(true)
    })

    it('reports conflict and keeps the backup when the orphan is not owned', async () => {
      const adapter = new FakeSystemProxyAdapter()
      const backup = new InMemorySystemProxyBackupStore()
      const first = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'owner' })
      await first.enable()
      adapter.mutate({ proxyEnable: { exists: true, type: 'REG_DWORD', value: 0 } })
      const next = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'growth-2' })
      const status = await next.init()
      expect(status.phase).toBe('conflict')
      await expect(backup.read()).resolves.not.toBeNull()
    })

    it('reports conflict on a corrupt backup without touching the registry', async () => {
      const { service } = makeService({ backup: new ThrowingBackupStore() })
      const status = await service.init()
      expect(status.phase).toBe('conflict')
      expect(service.getStatus().errorMessage).toBe('系统代理备份无效，请手动恢复')
    })

    it('cleans up a stale bundle whose restore already completed (matches previous, not owned)', async () => {
      // Simulate a restore that finished but whose backup-delete was interrupted
      // (a crash between restore and delete): the registry now equals the
      // pre-enable snapshot while the owned bundle is still on disk. On the next
      // launch `init()` must drop the stale bundle and report `disabled`, never a
      // misleading `conflict` that recurses every boot.
      const adapter = new FakeSystemProxyAdapter()
      const backup = new InMemorySystemProxyBackupStore()
      const first = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'owner' })
      await first.enable()
      const bundle = await backup.read()
      expect(bundle).not.toBeNull()
      await adapter.restore(bundle!.previous) // registry is already restored to previous
      const restoreCallsBefore = adapter.calls.filter((c) => c.op === 'restore').length

      const next = new SystemProxyService({ adapter, probe: new StaticSystemProxyProbe(TARGET), backup, instanceId: 'growth-2' })
      const status = await next.init()
      expect(status.phase).toBe('disabled')
      await expect(backup.read()).resolves.toBeNull()
      // Nothing owed: init must not re-apply a restore for an already-restored state.
      expect(adapter.calls.filter((c) => c.op === 'restore').length).toBe(restoreCallsBefore)
    })
  })

  describe('concurrency', () => {
    it('serializes enable/disable so the OS never sees interleaved values', async () => {
      const { service } = makeService()
      await Promise.all([service.enable(), service.disable()])
      expect(service.getStatus().phase).toBe('disabled')
    })
  })
})
