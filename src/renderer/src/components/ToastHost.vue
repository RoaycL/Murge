<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { useToast } from '../composables/use-toast'

const toast = useToast()
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="toast">
        <section v-for="message in toast.messages.value" :key="message.id" class="toast-item" :class="message.tone" role="status">
          <AppIcon :name="message.tone === 'success' ? 'success' : message.tone === 'error' ? 'error' : 'about'" :size="18" />
          <div><strong>{{ message.title }}</strong><p v-if="message.detail">{{ message.detail }}</p></div>
          <button type="button" aria-label="关闭通知" @click="toast.dismiss(message.id)"><AppIcon name="close" :size="14" /></button>
        </section>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host { position: fixed; z-index: 300; right: 18px; bottom: 18px; display: grid; width: min(340px, calc(100vw - 36px)); gap: 8px; pointer-events: none; }
.toast-item { display: grid; grid-template-columns: 20px 1fr 24px; align-items: start; gap: 9px; padding: 11px 10px 11px 12px; border: 1px solid var(--app-divider); border-radius: 10px; background: color-mix(in srgb, var(--app-surface) 96%, var(--app-bg)); color: var(--app-text); box-shadow: 0 12px 32px rgba(0,0,0,.24); pointer-events: auto; }
.toast-item > svg { margin-top: 1px; }
.toast-item.success > svg { color: var(--app-green); }
.toast-item.error > svg { color: var(--app-danger, #d64f4f); }
.toast-item.info > svg { color: var(--app-blue); }
.toast-item strong { display: block; font-size: 12px; font-weight: 650; }
.toast-item p { margin: 3px 0 0; color: var(--app-muted); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.toast-item button { display: grid; width: 24px; height: 24px; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--app-muted); }
.toast-item button:hover { background: rgba(127,127,127,.12); color: var(--app-text); }
.toast-enter-active, .toast-leave-active { transition: opacity .18s ease, transform .18s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
