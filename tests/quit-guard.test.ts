import { describe, it, expect } from 'vitest'
import { runQuitFlow } from '../src/main/quit-guard'

describe('runQuitFlow (P1-1 quit invariant)', () => {
  it('stops the kernel, disposes services and quits when the proxy restores', async () => {
    let stopped = 0
    let disposed = 0
    let quitCount = 0
    const result = await runQuitFlow({
      restore: async () => true,
      stopKernel: async () => {
        stopped++
      },
      dispose: async () => {
        disposed++
      },
      quit: () => {
        quitCount++
      }
    })
    expect(result).toBe('quitting')
    expect(stopped).toBe(1)
    expect(disposed).toBe(1)
    expect(quitCount).toBe(1)
  })

  it('NEVER stops the kernel, disposes services or quits when the proxy fails to restore', async () => {
    let stopped = 0
    let disposed = 0
    let quitCount = 0
    const result = await runQuitFlow({
      restore: async () => false,
      stopKernel: async () => {
        stopped++
      },
      dispose: async () => {
        disposed++
      },
      quit: () => {
        quitCount++
      }
    })
    expect(result).toBe('restore-failed')
    expect(stopped).toBe(0)
    expect(disposed).toBe(0)
    expect(quitCount).toBe(0)
  })

  it('still quits after a confirmed restore even when disposing throws', async () => {
    let quitCount = 0
    const result = await runQuitFlow({
      restore: async () => true,
      dispose: async () => {
        throw new Error('dispose bomb')
      },
      quit: () => {
        quitCount++
      }
    })
    expect(result).toBe('quitting')
    expect(quitCount).toBe(1)
  })
})
