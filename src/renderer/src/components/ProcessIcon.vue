<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ path?: string; name?: string; size?: number }>()
const source = ref<string | null>(null)
const load = async (): Promise<void> => { source.value = props.path ? await window.desktop.app.getProcessIcon(props.path) : null }
onMounted(load)
watch(() => props.path, load)
</script>
<template><span class="process-icon"><img v-if="source" :src="source" :alt="`${name || '进程'}图标`" /><AppIcon v-else name="processes" :size="size ?? 22" /></span></template>
