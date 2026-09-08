<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ path?: string; name?: string; size?: number }>()
const source = ref<string | null>(null)
let generation = 0
const load = async (): Promise<void> => {
  const current = ++generation
  const path = props.path
  try {
    const result = path ? await window.desktop.app.getProcessIcon(path) : null
    if (current === generation && path === props.path) source.value = result
  } catch {
    if (current === generation && path === props.path) source.value = null
  }
}
onMounted(load)
watch(() => props.path, load)
</script>
<template><span class="process-icon"><img v-if="source" :src="source" :alt="`${name || '进程'}图标`" /><AppIcon v-else name="processes" :size="size ?? 22" /></span></template>
