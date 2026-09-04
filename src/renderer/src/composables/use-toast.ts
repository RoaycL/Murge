import { readonly, ref } from 'vue'

export type ToastTone = 'success' | 'error' | 'info'
export interface ToastMessage { id: number; title: string; detail?: string; tone: ToastTone }

const messages = ref<ToastMessage[]>([])
let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function dismiss(id: number): void {
  messages.value = messages.value.filter((item) => item.id !== id)
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
}

function show(tone: ToastTone, title: string, detail?: string, duration = tone === 'error' ? 6000 : 3200): number {
  const id = nextId++
  messages.value = [...messages.value.slice(-2), { id, tone, title, detail }]
  timers.set(id, setTimeout(() => dismiss(id), duration))
  return id
}

export function useToast() {
  return {
    messages: readonly(messages), dismiss,
    success: (title: string, detail?: string) => show('success', title, detail),
    error: (title: string, detail?: string) => show('error', title, detail),
    info: (title: string, detail?: string) => show('info', title, detail)
  }
}
