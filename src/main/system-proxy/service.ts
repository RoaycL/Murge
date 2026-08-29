import type { SystemProxyStatus, SystemProxyPhase } from '../../shared/system-proxy'
import type { SystemProxyGateway } from '../../shared/gateways'
import { ProtocolError, ProtocolErrorCode, toProtocolError } from '../../shared/protocol-errors'
import { parseSystemProxyStatus } from '../../shared/schemas/system-proxy'
import { SYSTEM_PROXY_BACKUP_SCHEMA_VERSION } from './backup-store'
import {
  buildWrittenState,
  conflictDetail,
  formatAddress,
  isOwned,
  matchesPrevious,
  validateRestorable,
  validateTarget
} from './policy'
import type {
  SystemProxyAdapter,
  SystemProxyBackup,
  SystemProxyBackupStore,
  SystemProxyKernelProbe,
  SystemProxyTarget
} from './types'

export type SystemProxyListener = (status: SystemProxyStatus) => void

export interface SystemProxyServiceOptions {
  adapter: SystemProxyAdapter
  probe: SystemProxyKernelProbe
  backup: SystemProxyBackupStore
  instanceId: string
}

const NOT_SUPPORTED_MSG = '当前平台不支持系统代理'
const CONFLICT_MSG = '系统代理已被外部修改，未执行还原'

/**
 * Ownership-aware system-proxy controller.
 *
 * The logic is deliberately independent of any registry / `reg.exe` / PowerShell
 * implementation — it drives a {@link SystemProxyAdapter} and an injectable
 * backup store and probe, so every branch is unit-testable on the Mac/Linux dev
 * box. It owns the *first* backup it writes and refuses to overwrite a value that
 * was modified externally after it took ownership.
 */
export class SystemProxyService implements SystemProxyGateway {
  private readonly adapter: SystemProxyAdapter
  private readonly probe: SystemProxyKernelProbe
  private readonly backup: SystemProxyBackupStore
  private readonly instanceId: string
  private readonly listeners = new Set<SystemProxyListener>()
  private current: SystemProxyStatus
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: SystemProxyServiceOptions) {
    this.adapter = options.adapter
    this.probe = options.probe
    this.backup = options.backup
    this.instanceId = options.instanceId
    this.current = this.buildStatus(this.adapter.supported ? 'disabled' : 'unsupported')
  }

  getStatus(): SystemProxyStatus {
    return this.current
  }

  onStatus(listener: SystemProxyListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Recover any orphan bundle left by a previous crash. Called once at startup
   * before IPC is exposed.
   */
  async init(): Promise<SystemProxyStatus> {
    return this.serialize(async () => {
      if (!this.adapter.supported) return this.transition('unsupported')
      let backup: SystemProxyBackup | null
      try {
        backup = await this.backup.read()
      } catch {
        // A corrupt / schema-mismatched backup cannot be trusted to restore the
        // original values. Fail closed: refuse to guess and do not touch the
        // registry, so we never overwrite an external value to "recover".
        return this.transition('conflict', {
          errorMessage: '系统代理备份无效，请手动恢复',
          conflictDetail: '备份文件损坏或版本不匹配'
        })
      }
      if (!backup) return this.transition('disabled')

      const observed = await this.adapter.read()
      // The registry already matches the *pre-enable* snapshot: a prior restore
      // completed but its backup-delete failed (a crash between restore and
      // delete), so this is a stale owned bundle, not an external edit. Drop it
      // and report disabled instead of surfacing a misleading conflict that would
      // otherwise recurse every launch.
      if (matchesPrevious(observed, backup.previous)) {
        try {
          await this.backup.delete()
        } catch {
          // Deleting the stale bundle failed; the proxy is still correctly off,
          // so report disabled and let the next launch (or the standalone
          // recovery helper) retry the cleanup.
        }
        return this.transition('disabled')
      }
      if (!isOwned(observed, backup.written)) {
        return this.transition('conflict', {
          errorMessage: CONFLICT_MSG,
          conflictDetail: conflictDetail(observed, backup.written)
        })
      }

      this.transition('restoring')
      return this.restoreBackup(backup)
    })
  }

  async enable(): Promise<SystemProxyStatus> {
    return this.serialize(async () => {
      if (!this.adapter.supported) {
        return this.fail('unsupported', ProtocolErrorCode.SYSTEM_PROXY_UNSUPPORTED, NOT_SUPPORTED_MSG)
      }

      // Kernel / controller gate — the proxy may only point at a live listener.
      let target: SystemProxyTarget
      try {
        target = validateTarget(await this.probe.resolveTarget())
      } catch (error) {
        const code = toProtocolError(error).code
        if (code === ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED) {
          this.transition('disabled', { errorMessage: '请先启动内核' })
          throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_KERNEL_REQUIRED, '请先启动内核后再启用系统代理')
        }
        throw error
      }

      // An existing owned bundle: either we are already enabled (idempotent) or
      // the OS values were mutated externally (conflict — never overwrite).
      const existing = await this.readBackupForOwnership()
      if (existing) {
        const observed = await this.adapter.read()
        if (isOwned(observed, existing.written)) {
          return this.transition('enabled', {
            address: formatAddress(existing.target),
            port: existing.target.port
          })
        }
        const detail = conflictDetail(observed, existing.written)
        return this.fail('conflict', ProtocolErrorCode.SYSTEM_PROXY_STATE_CONFLICT, CONFLICT_MSG, detail)
      }

      // Fresh enable: snapshot the pre-enable registry, persist the owned bundle
      // BEFORE applying so a crash mid-apply is recoverable next launch. Refuse
      // up front if the pre-enable state holds a value we could not faithfully
      // restore — never enable on an un-restorable state.
      const observed = await this.adapter.read()
      validateRestorable(observed)
      const written = buildWrittenState(target, observed)
      const bundle: SystemProxyBackup = {
        schemaVersion: SYSTEM_PROXY_BACKUP_SCHEMA_VERSION,
        instanceId: this.instanceId,
        createdAt: new Date().toISOString(),
        target,
        previous: observed,
        written
      }
      try {
        await this.backup.write(bundle)
      } catch {
        return this.fail('disabled', ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, '无法写入系统代理备份，未应用更改')
      }

      this.transition('enabling')
      try {
        await this.adapter.apply(written)
        await this.adapter.refresh()
        const readback = await this.adapter.read()
        if (!isOwned(readback, written)) {
          throw new Error('read-back mismatch after apply')
        }
      } catch (error) {
        // `apply` may have written a subset before failing (a `reg add` sequence
        // that dies part-way), so always attempt a *confirmed* restore. Only a
        // restored + verified + read-back state may delete the bundle; a rollback
        // failure is surfaced as restore-failed, never swallowed into `disabled`.
        try {
          await this.rollback(bundle)
        } catch (rollbackError) {
          return this.fail('restore-failed', ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '系统代理启用失败且无法还原，已保留备份', null, rollbackError)
        }
        return this.fail('disabled', ProtocolErrorCode.SYSTEM_PROXY_ENABLE_FAILED, '系统代理启用失败，已还原', null, error)
      }

      return this.transition('enabled', { address: formatAddress(target), port: target.port })
    })
  }

  async disable(): Promise<SystemProxyStatus> {
    return this.serialize(async () => {
      if (!this.adapter.supported) {
        return this.fail('unsupported', ProtocolErrorCode.SYSTEM_PROXY_UNSUPPORTED, NOT_SUPPORTED_MSG)
      }
      let backup: SystemProxyBackup | null
      try {
        backup = await this.backup.read()
      } catch {
        return this.fail('conflict', ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '系统代理备份无效，请手动恢复')
      }
      if (!backup) return this.transition('disabled') // Idempotent: nothing owned.

      const observed = await this.adapter.read()
      if (!isOwned(observed, backup.written)) {
        const detail = conflictDetail(observed, backup.written)
        return this.fail('conflict', ProtocolErrorCode.SYSTEM_PROXY_STATE_CONFLICT, CONFLICT_MSG, detail)
      }

      this.transition('restoring')
      return this.restoreBackup(backup)
    })
  }

  /**
   * Restore the owned bundle in preparation for the kernel becoming unavailable
   * (a user stop, app shutdown, or a crash). A conflict is treated as safe — the
   * proxy no longer points at us — while a genuine restore failure is surfaced so
   * the caller never silently stops the kernel and leaves a dead-port proxy.
   */
  async restoreBeforeKernelUnavailable(): Promise<void> {
    await this.serialize(async () => {
      if (!this.adapter.supported) return
      let backup: SystemProxyBackup | null
      try {
        backup = await this.backup.read()
      } catch {
        this.transition('conflict', { errorMessage: '系统代理备份无效，请手动恢复' })
        throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '系统代理备份无效，无法安全停止内核')
      }
      if (!backup) return
      const observed = await this.adapter.read()
      if (!isOwned(observed, backup.written)) {
        // Conflict: the proxy is not ours anymore, so it is safe to stop the
        // kernel. Report the conflict and do not touch the registry.
        this.transition('conflict', {
          errorMessage: CONFLICT_MSG,
          conflictDetail: conflictDetail(observed, backup.written)
        })
        return
      }
      this.transition('restoring')
      try {
        await this.restoreBackupStrict(backup)
      } catch (error) {
        this.transition('restore-failed', { errorMessage: '系统代理还原失败' })
        throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '系统代理还原失败，内核停止已中止')
      }
      this.transition('disabled')
    })
  }

  private async readBackupForOwnership(): Promise<SystemProxyBackup | null> {
    try {
      return await this.backup.read()
    } catch {
      // A corrupt backup on enable should also fail closed (can't guarantee
      // restore), rather than enabling on top of an un-restorable state.
      throw new ProtocolError(ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '系统代理备份无效，无法启用')
    }
  }

  /** Restore the bundle and delete it; safe (non-throwing) variant for `disable`. */
  private async restoreBackup(backup: SystemProxyBackup): Promise<SystemProxyStatus> {
    try {
      await this.restoreBackupStrict(backup)
    } catch (error) {
      // Keep the bundle so a retry / recovery can still restore it.
      console.error('[system-proxy] restore failed:', error instanceof Error ? error.message : error)
      return this.fail('restore-failed', ProtocolErrorCode.SYSTEM_PROXY_RESTORE_FAILED, '系统代理还原失败', null, error)
    }
    return this.transition('disabled')
  }

  /** Restore the bundle and delete it, throwing on a restore/verify failure. */
  private async restoreBackupStrict(backup: SystemProxyBackup): Promise<void> {
    await this.adapter.restore(backup.previous)
    await this.adapter.refresh()
    const readback = await this.adapter.read()
    if (!matchesPrevious(readback, backup.previous)) {
      // A read-back mismatch means we cannot prove the restore worked. Keep the
      // bundle so a later retry / crash recovery still has the original values.
      const why = conflictDetail(readback, backup.previous)
      throw new Error(
        `restore read-back mismatch: ${why || 'no differing keys'} | previous=${JSON.stringify(backup.previous)} | readback=${JSON.stringify(readback)}`
      )
    }
    await this.backup.delete()
  }

  /**
   * Roll back a partially-applied enable. Reuses the strict restore path
   * (restore → refresh → read-back verify → delete-on-success) so a failed
   * rollback keeps the bundle for a later retry / crash recovery, and throws
   * rather than being swallowed by the caller.
   */
  private async rollback(backup: SystemProxyBackup): Promise<void> {
    await this.restoreBackupStrict(backup)
  }

  private buildStatus(phase: SystemProxyPhase, extra: Partial<SystemProxyStatus> = {}): SystemProxyStatus {
    const base: SystemProxyStatus = {
      supported: this.adapter.supported,
      phase,
      address: null,
      port: null,
      errorMessage: null,
      conflictDetail: null,
      updatedAt: new Date().toISOString()
    }
    return parseSystemProxyStatus({ ...base, ...extra })
  }

  private transition(phase: SystemProxyPhase, extra: Partial<SystemProxyStatus> = {}): SystemProxyStatus {
    const status = this.buildStatus(phase, extra)
    this.current = status
    this.emit(status)
    return status
  }

  private emit(status: SystemProxyStatus): void {
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (error) {
        console.error('[system-proxy] status listener failed:', error)
      }
    }
  }

  private fail(
    phase: SystemProxyPhase,
    code: ProtocolErrorCode,
    message: string,
    conflictDetail: string | null = null,
    _originalError?: unknown
  ): never {
    this.transition(phase, { errorMessage: message, conflictDetail })
    throw new ProtocolError(code, message)
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => task())
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
