<script setup lang="ts">
import { computed } from 'vue'
import { BRAND_ICONS, type BrandIconName } from '../lib/brand-icons'
const props = defineProps<{ name: BrandIconName; size?: number }>()
const icon = computed(() => BRAND_ICONS[props.name])
</script>

<template>
  <span class="brand-icon" :style="{ width: `${size ?? 22}px`, height: `${size ?? 22}px`, background: icon.background }" role="img" :aria-label="icon.label" :title="icon.label">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icon.path" fill="#fff" /></svg>
  </span>
</template>

<style scoped>
.brand-icon { display: inline-grid; flex: none; place-items: center; border-radius: 22%; }
.brand-icon svg { width: 66%; height: 66%; }
</style>
