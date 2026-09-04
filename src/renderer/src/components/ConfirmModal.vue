<script setup lang="ts">
import AppIcon from './AppIcon.vue'

defineProps<{ open: boolean; title: string; description: string; confirmLabel?: string; busy?: boolean }>()
defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <Teleport to="body"><div v-if="open" class="modal-shade" role="presentation" @click.self="$emit('close')"><section class="confirm-modal" role="alertdialog" :aria-label="title"><header><h2>{{ title }}</h2><button type="button" class="icon-control" aria-label="关闭" @click="$emit('close')"><AppIcon name="close" /></button></header><p>{{ description }}</p><footer><button type="button" class="secondary-button" @click="$emit('close')">取消</button><button type="button" class="danger-button solid" :disabled="busy" @click="$emit('confirm')"><AppIcon name="delete" :size="15" />{{ busy ? '处理中…' : (confirmLabel ?? '确认删除') }}</button></footer></section></div></Teleport>
</template>
