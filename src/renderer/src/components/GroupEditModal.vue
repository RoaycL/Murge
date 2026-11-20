<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, nextTick, ref, toRef, watch } from 'vue'
import CachedRemoteIcon from './CachedRemoteIcon.vue'
import { useDialogFocus } from '../composables/use-dialog-focus'

/**
 * 策略组右键 › 编辑名称与图标: a small sheet for the two fields people
 * change most, without walking the member wizard. Only local groups get it;
 * the caller renames every local reference (rules, other groups, nodes).
 */
const props = defineProps<{ open: boolean; name: string; icon: string; takenNames: string[]; busy?: boolean }>()
const emit = defineEmits<{ close: []; save: [{ name: string; icon: string }] }>()

const dialog = ref<HTMLElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const name = ref('')
const icon = ref('')
/** The icon shown in the preview: updated on blur so typing does not fetch every keystroke. */
const previewIcon = ref('')
const error = ref<string | null>(null)

useDialogFocus(toRef(props, 'open'), dialog, () => { if (!props.busy) emit('close') })

watch(() => props.open, async (open) => {
  if (!open) return
  name.value = props.name
  icon.value = props.icon
  previewIcon.value = props.icon
  error.value = null
  await nextTick()
  nameInput.value?.select()
})

const renamed = computed(() => name.value.trim() !== props.name)
const changed = computed(() => renamed.value || icon.value.trim() !== props.icon.trim())

function refreshPreview(): void {
  const url = icon.value.trim()
  previewIcon.value = /^(https?:\/\/|data:image\/)/i.test(url) ? url : ''
}

function submit(): void {
  if (props.busy) return
  const nextName = name.value.trim()
  const nextIcon = icon.value.trim()
  if (!nextName) {
    error.value = t('groupWizard.nameRequired')
    return
  }
  // Rule lines are comma-separated: a comma in the name would split the retargeted rules.
  if (nextName.includes(',')) {
    error.value = t('groupWizard.nameComma')
    return
  }
  if (nextName !== props.name && props.takenNames.includes(nextName)) {
    error.value = t('groupWizard.nameTaken', [nextName])
    return
  }
  if (nextIcon && !/^(https?:\/\/|data:image\/)/i.test(nextIcon)) {
    error.value = t('groupEdit.iconInvalid')
    return
  }
  if (!changed.value) {
    emit('close')
    return
  }
  error.value = null
  emit('save', { name: nextName, icon: nextIcon })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-shade group-edit-shade" role="presentation" @click.self="!busy && emit('close')">
      <form ref="dialog" class="group-edit" role="dialog" aria-modal="true" :aria-label="t('groupEdit.title', [props.name])" @submit.prevent="submit">
        <header class="ge-head">
          <span class="ge-icon" aria-hidden="true"><CachedRemoteIcon v-if="previewIcon" :src="previewIcon" :cache-key="previewIcon" /></span>
          <div>
            <h2>{{ t('groupEdit.title', [props.name]) }}</h2>
            <p>{{ t('groupEdit.subtitle') }}</p>
          </div>
        </header>
        <div class="ge-body">
          <div class="ge-card">
            <label class="ge-row"><span class="ge-label"><b>{{ t('common.name') }}</b></span><input ref="nameInput" v-model="name" class="ge-input" type="text" spellcheck="false" :placeholder="t('common.required')" @input="error = null" /></label>
            <label class="ge-row"><span class="ge-label"><b>{{ t('groupWizard.icon') }}</b><small>{{ t('groupWizard.iconHint') }}</small></span><input v-model="icon" class="ge-input" type="url" spellcheck="false" placeholder="https://…" @input="error = null" @blur="refreshPreview" /></label>
          </div>
          <p v-if="renamed" class="ge-note">{{ t('groupEdit.renameNote') }}</p>
        </div>
        <footer class="ge-foot">
          <p v-if="error" class="ge-error" role="alert">{{ error }}</p>
          <span class="spacer" />
          <button type="button" class="surge-button" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</button>
          <button type="submit" class="surge-button primary" :disabled="busy">{{ busy ? t('common.saving') : t('common.save') }}</button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.group-edit-shade { z-index: 72; background: rgba(9, 11, 15, 0.28); }
.group-edit { display: flex; flex-direction: column; width: min(460px, calc(100vw - 40px)); overflow: hidden; border: 1px solid var(--glass-edge); border-radius: 14px; color: var(--app-text); background: var(--glass-bg); -webkit-backdrop-filter: var(--glass-filter); backdrop-filter: var(--glass-filter); box-shadow: var(--glass-shadow); }
.ge-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--app-divider); }
.ge-head > div { min-width: 0; }
.ge-head h2 { overflow: hidden; margin: 0; font-size: var(--font-size-body); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.ge-head p { margin: 3px 0 0; color: var(--app-muted); font-size: var(--font-size-2xs); }
.ge-icon { display: grid; flex: none; place-items: center; width: 32px; height: 32px; overflow: hidden; border-radius: 8px; background: color-mix(in srgb, var(--app-text) 6%, transparent); }
.ge-icon :deep(img) { width: 100%; height: 100%; object-fit: contain; }
.ge-body { display: grid; gap: 10px; padding: 16px 20px; }
.ge-card { display: grid; padding: 0 14px; border-radius: 10px; background: color-mix(in srgb, var(--app-text) 4.5%, transparent); }
.ge-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 40px; padding: 8px 0; border-top: 1px solid var(--app-divider); font-size: var(--font-size-sm); }
.ge-row:first-child { border-top: 0; }
.ge-label { display: grid; gap: 3px; min-width: 0; }
.ge-label b { font-weight: 600; }
.ge-label small { color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.45; }
.ge-input { flex: 0 1 240px; width: 240px; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--app-divider); border-radius: 6px; background: var(--app-surface-solid); color: var(--app-text); font-size: var(--font-size-sm); }
.ge-input::placeholder { color: var(--app-faint); }
.ge-input:focus { outline: none; border-color: var(--app-blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-blue) 22%, transparent); }
.ge-note { margin: 0 4px; color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.5; }
.ge-foot { display: flex; align-items: center; gap: var(--space-3); padding: 12px 20px; border-top: 1px solid var(--app-divider); }
.ge-foot .spacer { flex: 1; }
.ge-error { margin: 0; overflow: hidden; color: var(--app-danger); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
</style>
