<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import type { ProfileProviderContent } from '@shared/profiles'
import AppIcon from './AppIcon.vue'
import { useDialogFocus } from '../composables/use-dialog-focus'

const props = defineProps<{
  open: boolean
  kind: 'proxy' | 'rule'
  name: string
}>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const result = ref<ProfileProviderContent | null>(null)
const copied = ref(false)
let loadRevision = 0

useDialogFocus(toRef(props, 'open'), dialog, () => emit('close'))

const subtitle = computed(() => {
  if (!result.value) return props.kind === 'proxy' ? '代理集合内容' : '规则集合内容'
  const source = result.value.source === 'inline' ? '内联配置' : 'mihomo 实际缓存'
  return `${source} · ${result.value.format.toUpperCase()}`
})

watch(
  () => [props.open, props.kind, props.name] as const,
  async ([open, kind, name]) => {
    if (!open) return
    const revision = ++loadRevision
    loading.value = true
    error.value = null
    result.value = null
    copied.value = false
    try {
      const value = await window.desktop.profiles.getProviderContent(kind, name)
      if (revision === loadRevision) result.value = value
    } catch (reason) {
      if (revision === loadRevision) error.value = reason instanceof Error ? reason.message : '读取外部资源失败'
    } finally {
      if (revision === loadRevision) loading.value = false
    }
  },
  { immediate: true }
)

async function copyContent(): Promise<void> {
  if (!result.value) return
  await navigator.clipboard.writeText(result.value.content)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="provider-content-backdrop" @click.self="emit('close')">
      <section ref="dialog" class="provider-content-modal" role="dialog" aria-modal="true" :aria-label="`${name} 资源内容`">
        <header>
          <div class="provider-content-heading">
            <h2>{{ name }}</h2>
            <p>{{ subtitle }}</p>
          </div>
          <div class="provider-content-actions">
            <button v-if="result" type="button" class="secondary-button compact" @click="copyContent">
              <AppIcon name="clipboard" :size="15" />{{ copied ? '已复制' : '复制' }}
            </button>
            <button type="button" class="icon-control" aria-label="关闭资源内容" @click="emit('close')"><AppIcon name="close" /></button>
          </div>
        </header>
        <div class="provider-content-body">
          <p v-if="loading" class="provider-content-state">正在读取实际缓存…</p>
          <div v-else-if="error" class="provider-content-error" role="alert">
            <AppIcon name="error" :size="18" /><span>{{ error }}</span>
          </div>
          <pre v-else-if="result" tabindex="0"><code>{{ result.content }}</code></pre>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.provider-content-backdrop { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; padding: clamp(14px, 4vw, 42px); background: rgb(8 10 18 / 46%); backdrop-filter: blur(3px); }
.provider-content-modal { width: min(960px, 100%); height: min(760px, 100%); min-height: 320px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--app-divider); border-radius: 20px; background: var(--app-surface); color: var(--app-text); box-shadow: 0 24px 72px rgb(0 0 0 / 28%); }
.provider-content-modal > header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 18px 20px; border-bottom: 1px solid var(--app-divider); }
.provider-content-heading { min-width: 0; }
.provider-content-heading h2 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; }
.provider-content-heading p { margin: 4px 0 0; color: var(--app-muted); font-size: 11px; }
.provider-content-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.secondary-button.compact { min-height: 30px; padding: 0 10px; display: inline-flex; align-items: center; gap: 5px; }
.provider-content-body { min-height: 0; flex: 1; padding: 14px; background: color-mix(in srgb, var(--app-surface) 92%, var(--app-text) 8%); }
.provider-content-body pre { box-sizing: border-box; width: 100%; height: 100%; margin: 0; overflow: auto; padding: 16px; border: 1px solid var(--app-divider); border-radius: 12px; background: var(--app-surface); color: var(--app-text); font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; white-space: pre; tab-size: 2; user-select: text; }
.provider-content-state { margin: 18px; color: var(--app-muted); }
.provider-content-error { display: flex; align-items: flex-start; gap: 8px; margin: 8px; padding: 13px 14px; border: 1px solid color-mix(in srgb, var(--app-danger, #d64f4f) 32%, transparent); border-radius: 10px; color: var(--app-danger, #d64f4f); background: color-mix(in srgb, var(--app-danger, #d64f4f) 8%, transparent); }
@media (max-width: 620px) {
  .provider-content-backdrop { padding: 8px; }
  .provider-content-modal { height: 100%; border-radius: 14px; }
  .provider-content-modal > header { padding: 14px; }
  .provider-content-body { padding: 8px; }
}
</style>
