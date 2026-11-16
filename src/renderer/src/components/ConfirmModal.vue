<script setup lang="ts">
import { t } from '@shared/i18n'
import AppIcon from './AppIcon.vue'
import { toRef, ref } from 'vue'
import { useDialogFocus } from '../composables/use-dialog-focus'

const props = defineProps<{ open: boolean; title: string; description: string; confirmLabel?: string; busy?: boolean }>()
const emit = defineEmits<{ close: []; confirm: [] }>()
const dialog = ref<HTMLElement | null>(null)
useDialogFocus(toRef(props, 'open'), dialog, () => { if (!props.busy) emit('close') })
</script>

<template>
  <Teleport to="body"><div v-if="open" class="modal-shade" role="presentation" @click.self="!busy && emit('close')"><section ref="dialog" class="confirm-modal" role="alertdialog" aria-modal="true" :aria-label="title"><header><h2>{{ title }}</h2><button type="button" class="icon-control" :aria-label="t('common.close')" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></header><p>{{ description }}</p><footer><button type="button" class="secondary-button" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</button><button type="button" class="danger-button solid" :disabled="busy" @click="emit('confirm')"><AppIcon name="delete" :size="15" />{{ busy ? t('common.processing') : (confirmLabel ?? t('confirm.confirmDelete')) }}</button></footer></section></div></Teleport>
</template>
