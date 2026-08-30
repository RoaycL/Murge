import { describe, expect, it } from 'vitest'
import { StartupService, type StartupAdapter } from '../src/main/startup/service'

class FakeAdapter implements StartupAdapter {
  supported = true
  value = false
  writes: boolean[] = []
  confirm = true
  fail: Error | null = null
  async read(): Promise<boolean> { return this.value }
  async write(enabled: boolean): Promise<void> { this.writes.push(enabled); if (this.fail) throw this.fail; if (this.confirm) this.value = enabled }
}

describe('StartupService', () => {
  it('is disabled by default and performs no write on read', async () => {
    const adapter = new FakeAdapter()
    const service = new StartupService(adapter)
    expect(await service.getStatus()).toMatchObject({ supported: true, enabled: false, phase: 'idle' })
    expect(adapter.writes).toEqual([])
  })

  it('requires an explicit set and confirms the OS state after writing', async () => {
    const adapter = new FakeAdapter()
    const service = new StartupService(adapter)
    expect(await service.setEnabled(true)).toMatchObject({ enabled: true, phase: 'idle' })
    expect(adapter.writes).toEqual([true])
  })

  it('reports divergence without pretending the requested value won', async () => {
    const adapter = new FakeAdapter(); adapter.confirm = false
    const status = await new StartupService(adapter).setEnabled(true)
    expect(status).toMatchObject({ enabled: false, phase: 'error' })
    expect(status.errorMessage).toContain('未确认')
  })

  it('fails closed on unsupported platforms without calling write', async () => {
    const adapter = new FakeAdapter(); adapter.supported = false
    const status = await new StartupService(adapter).setEnabled(true)
    expect(status).toEqual({ supported: false, enabled: false, phase: 'unsupported', errorMessage: null })
    expect(adapter.writes).toEqual([])
  })
})
