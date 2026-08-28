import { describe, it, expect, beforeAll } from 'vitest'
import { systemProxyBackupSchema } from '../src/main/system-proxy/backup-schema'
import { validateRestorable } from '../src/main/system-proxy/policy'

// The recovery helper is a standalone `.mjs` (node), so it is loaded at runtime
// the same way `system-proxy-recovery.test.ts` does — never statically imported —
// and only on a non-Windows host (vitest's Windows transform chokes on a top-level
// `.mjs` import). The point of this suite is that the helper's hand-rolled
// `validateBackupShape` / `validateRestorableState` must NEVER drift from the
// TypeScript/Zod schema and the app's `validateRestorable`.
type RecoveryScript = typeof import('../scripts/recover-system-proxy.mjs')
let validateBackupShape: RecoveryScript['validateBackupShape']
let validateRestorableState: RecoveryScript['validateRestorableState']

beforeAll(async () => {
  if (process.platform === 'win32') return
  const mod = await import('../scripts/recover-system-proxy.mjs')
  validateBackupShape = mod.validateBackupShape
  validateRestorableState = mod.validateRestorableState
})

const describePortable = process.platform === 'win32' ? describe.skip : describe

const dword = (value: number) => ({ exists: true, type: 'REG_DWORD', value })
const str = (value: string) => ({ exists: true, type: 'REG_SZ', value })
const ABSENT = { exists: false, type: 'none', value: null }

const base = {
  schemaVersion: 1,
  instanceId: 'align-instance',
  createdAt: '2024-01-01T00:00:00.000Z',
  target: { host: '127.0.0.1', port: 7890 },
  previous: { proxyEnable: dword(0), proxyServer: str('http=127.0.0.1:1'), proxyOverride: str('<local>') },
  written: { proxyEnable: dword(1), proxyServer: str('http=127.0.0.1:7890'), proxyOverride: str('<local>;localhost') }
}

describePortable('system-proxy backup schema alignment', () => {
  it('structural validity agrees between the Zod schema and the recovery helper', () => {
    const cases: Array<Record<string, unknown>> = [
      base,
      { ...base, schemaVersion: '1' },
      { ...base, schemaVersion: 2 },
      { ...base, createdAt: '2024-01-01' },
      { ...base, createdAt: '2024-01-01T00:00:00.000Z' },
      { ...base, createdAt: '2024-01-01T00:00:00+02:00' },
      { ...base, createdAt: '2024-13-45T00:00:00Z' },
      { ...base, createdAt: '2024-02-30T00:00:00Z' },
      { ...base, createdAt: '2024-02-29T00:00:00Z' },
      { ...base, createdAt: '2024-01-01T24:00:00Z' },
      { ...base, createdAt: '2024-01-01T00:00:60Z' },
      { ...base, target: { host: '0.0.0.0', port: 7890 } },
      { ...base, target: { host: '127.0.0.1', port: 0 } },
      { ...base, target: { host: '127.0.0.1', port: 7890.5 } },
      { ...base, target: { host: '127.0.0.1', port: 70000 } },
      { ...base, target: { host: '127.0.0.1', port: 65535 } },
      { ...base, extra: true },
      { ...base, target: { host: '127.0.0.1', port: 7890, extra: true } },
      { ...base, written: undefined },
      { ...base, previous: { ...base.previous, proxyServer: { exists: true, type: 'REG_MULTI_SZ', value: 'a;b' } } },
      { ...base, previous: { ...base.previous, proxyEnable: { exists: false, type: 'REG_DWORD', value: null } } },
      { ...base, previous: { ...base.previous, proxyEnable: { exists: false, type: 'none', value: 1 } } },
      { ...base, previous: { ...base.previous, proxyServer: { exists: true, type: 'REG_SZ', value: 123 } } },
      { ...base, previous: { ...base.previous, proxyEnable: { exists: true, type: 'REG_DWORD', value: 1.5 } } },
      { ...base, previous: { ...base.previous, proxyEnable: { exists: true, type: 'REG_DWORD', value: 2 ** 53 } } },
      { ...base, previous: { ...base.previous, proxyEnable: { exists: true, type: 'REG_QWORD', value: 0 } } },
      { ...base, previous: { ...base.previous, proxyServer: { exists: true, type: 'REG_BINARY', value: 'DEADBEEF' } } },
      { ...base, previous: { ...base.previous, proxyOverride: { exists: true, type: 'REG_EXPAND_SZ', value: '%PATH%' } } }
    ]

    for (const payload of cases) {
      const zodOk = systemProxyBackupSchema.safeParse(payload).success
      const helperOk = validateBackupShape(payload).length === 0
      expect(helperOk, `structural mismatch on payload ${JSON.stringify(payload)}`).toBe(zodOk)
    }
  })

  it('restorability agrees between the app validateRestorable and the recovery helper', () => {
    const states: Array<Record<string, unknown>> = [
      base.previous,
      { ...base.previous, proxyServer: { exists: true, type: 'REG_MULTI_SZ', value: 'a;b' } },
      { ...base.previous, proxyEnable: { exists: true, type: 'REG_QWORD', value: 0 } },
      { ...base.previous, proxyEnable: { exists: false, type: 'REG_DWORD', value: null } },
      { ...base.previous, proxyEnable: { exists: true, type: 'REG_DWORD', value: 1.5 } },
      { ...base.previous, proxyEnable: { exists: true, type: 'REG_BINARY', value: 'FF' } },
      { ...base.previous, proxyEnable: { exists: true, type: 'REG_EXPAND_SZ', value: '%x%' } },
      { ...base.previous, proxyServer: { exists: true, type: 'REG_SZ', value: '' } }
    ]

    for (const state of states) {
      let appOk = true
      try {
        validateRestorable(state as never)
      } catch {
        appOk = false
      }
      const helperOk = validateRestorableState(state).length === 0
      expect(helperOk, `restorability mismatch on state ${JSON.stringify(state)}`).toBe(appOk)
    }
  })
})
