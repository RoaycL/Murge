<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { toRef, ref } from 'vue'
import { useDialogFocus } from '../composables/use-dialog-focus'

const props = defineProps<{ open: boolean; title: string; subtitle?: string }>()
const emit = defineEmits<{ close: [] }>()
const drawer = ref<HTMLElement | null>(null)
useDialogFocus(toRef(props, 'open'), drawer, () => emit('close'))
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer-fade">
      <button v-if="open" type="button" class="detail-drawer-shade" aria-label="关闭详情" @click="$emit('close')" />
    </Transition>
    <Transition name="drawer-slide">
      <aside v-if="open" ref="drawer" class="detail-drawer" aria-modal="true" role="dialog" :aria-label="title">
        <header class="detail-drawer-header">
          <div><h2>{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></div>
          <button type="button" class="icon-control" aria-label="关闭详情" @click="$emit('close')"><AppIcon name="drawer-close" /></button>
        </header>
        <div class="detail-drawer-body"><slot /></div>
        <footer v-if="$slots.footer" class="detail-drawer-footer"><slot name="footer" /></footer>
      </aside>
    </Transition>
  </Teleport>
</template>
