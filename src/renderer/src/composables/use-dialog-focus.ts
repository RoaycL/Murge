import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function useDialogFocus(open: Ref<boolean>, container: Ref<HTMLElement | null>, close: () => void): void {
  let previous: HTMLElement | null = null

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab' || !container.value) return
    const controls = [...container.value.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (!controls.length) return
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  watch(open, async (value) => {
    if (value) {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      container.value?.querySelector<HTMLElement>('[autofocus], input, textarea, button:not(:disabled)')?.focus()
    } else {
      document.removeEventListener('keydown', onKeydown)
      previous?.focus()
      previous = null
    }
  }, { immediate: true })

  onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
}
