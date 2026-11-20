import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = {
  profiles: [{ id: 'p1', name: 'Main', active: false, source: { type: 'manual' } }],
  validate: vi.fn(async () => ({ ok: true, issues: [] })),
  replaceDocument: vi.fn(async (_id: string, document: string) => { stored = document })
}
const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn() }
vi.mock('../src/renderer/src/stores/profiles', () => ({ useProfilesStore: () => store }))
vi.mock('../src/renderer/src/composables/use-toast', () => ({ useToast: () => toast }))

const { openProfileFile, syncExternalEdits, resetExternalProfileEdits } = await import('../src/renderer/src/composables/use-external-profile-edits')

let stored = 'a: 1\n'
let copy = 'a: 1\n'

beforeEach(() => {
  resetExternalProfileEdits()
  stored = 'a: 1\n'
  copy = 'a: 1\n'
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = {
    addEventListener: vi.fn(),
    desktop: {
      profiles: {
        openFile: vi.fn(async () => ({ keptUnapplied: false })),
        readExternal: vi.fn(async () => copy),
        get: vi.fn(async () => ({ document: stored }))
      }
    }
  }
})

describe('external profile edits', () => {
  it('applies a save made in the editor', async () => {
    await openProfileFile('p1')
    copy = 'a: 2\n'
    await syncExternalEdits()
    expect(store.replaceDocument).toHaveBeenCalledWith('p1', 'a: 2\n')
    expect(stored).toBe('a: 2\n')
  })

  it('does not overwrite a profile that changed elsewhere after the copy was opened', async () => {
    await openProfileFile('p1')
    stored = 'a: 1\nb: subscription-update\n'
    copy = 'a: 2\n'
    await syncExternalEdits()
    expect(store.replaceDocument).not.toHaveBeenCalled()
    expect(stored).toBe('a: 1\nb: subscription-update\n')
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('keeps applying later saves after its own apply', async () => {
    await openProfileFile('p1')
    copy = 'a: 2\n'
    await syncExternalEdits()
    copy = 'a: 3\n'
    await syncExternalEdits()
    expect(store.replaceDocument).toHaveBeenLastCalledWith('p1', 'a: 3\n')
    expect(stored).toBe('a: 3\n')
  })
})

describe('subscription profiles', () => {
  it('are never opened for external editing', async () => {
    store.profiles.push({ id: 'sub', name: 'Sub', active: false, source: { type: 'url' } } as never)
    try {
      await openProfileFile('sub')
      const profiles = (window as unknown as { desktop: { profiles: { openFile: ReturnType<typeof vi.fn> } } }).desktop.profiles
      expect(profiles.openFile).not.toHaveBeenCalled()
    } finally {
      store.profiles.pop()
    }
  })
})

describe('missing working copy', () => {
  it('keeps watching while an editor briefly removes the copy during a save', async () => {
    await openProfileFile('p1')
    const profiles = (window as unknown as { desktop: { profiles: { readExternal: ReturnType<typeof vi.fn> } } }).desktop.profiles
    profiles.readExternal.mockResolvedValueOnce(null)
    await syncExternalEdits()
    copy = 'a: 2\n'
    await syncExternalEdits()
    expect(store.replaceDocument).toHaveBeenCalledWith('p1', 'a: 2\n')
  })
})
