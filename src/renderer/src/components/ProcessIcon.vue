<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import BrandIcon from './BrandIcon.vue'
import { processBrand, type BrandIconName } from '../lib/brand-icons'
/** `brand` overrides the process icon, e.g. for connections through a Tailscale node. */
const props = defineProps<{ path?: string; name?: string; size?: number; brand?: BrandIconName | null }>()
const shownBrand = computed(() => props.brand ?? processBrand(props.name, props.path))
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
<template><span class="process-icon"><BrandIcon v-if="shownBrand" :name="shownBrand" :size="size ?? 22" /><img v-else-if="source" :src="source" :alt="`${name || '进程'}图标`" /><AppIcon v-else name="processes" :size="size ?? 22" /></span></template>
