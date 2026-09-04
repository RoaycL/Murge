<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { toRef, ref } from 'vue'
import { useDialogFocus } from '../composables/use-dialog-focus'

const props = defineProps<{ open: boolean; title: string; description: string; confirmLabel?: string; busy?: boolean }>()
const emit = defineEmits<{ close: []; confirm: [] }>()
const dialog = ref<HTMLElement | null>(null)
useDialogFocus(toRef(props, 'open'), dialog, () => { if (!props.busy) emit('close') })
</script>

<template>
  <Teleport to="body"><div v-if="open" class="modal-shade" role="presentation" @click.self="!busy && emit('close')"><section ref="dialog" class="confirm-modal" role="alertdialog" aria-modal="true" :aria-label="title"><header><h2>{{ title }}</h2><button type="button" class="icon-control" aria-label="关闭" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></header><p>{{ description }}</p><footer><button type="button" class="secondary-button" :disabled="busy" @click="emit('close')">取消</button><button type="button" class="danger-button solid" :disabled="busy" @click="emit('confirm')"><AppIcon name="delete" :size="15" />{{ busy ? '处理中…' : (confirmLabel ?? '确认删除') }}</button></footer></section></div></Teleport>
</template>
