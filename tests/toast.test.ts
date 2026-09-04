import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToast } from '../src/renderer/src/composables/use-toast'

describe('toast feedback', () => {
  afterEach(() => {
    const toast = useToast()
    for (const message of [...toast.messages.value]) toast.dismiss(message.id)
    vi.useRealTimers()
  })

  it('keeps the latest three messages and dismisses them automatically', () => {
    vi.useFakeTimers()
    const toast = useToast()
    toast.info('one')
    toast.success('two')
    toast.error('three')
    toast.info('four')
    expect(toast.messages.value.map((item) => item.title)).toEqual(['two', 'three', 'four'])
    vi.advanceTimersByTime(6000)
    expect(toast.messages.value).toHaveLength(0)
  })

  it('supports explicit dismissal', () => {
    const toast = useToast()
    const id = toast.success('saved')
    expect(toast.messages.value).toHaveLength(1)
    toast.dismiss(id)
    expect(toast.messages.value).toHaveLength(0)
  })
})
