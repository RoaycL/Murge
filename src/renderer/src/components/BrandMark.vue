<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 38 })
</script>

<template>
  <svg class="brand-mark" :width="size" :height="size" viewBox="0 0 64 64" aria-hidden="true">
    <rect x="2" y="2" width="60" height="60" rx="14" class="brand-mark-background" />
    <path d="M15 48V18c0-4 4-6 7-3l10 10 10-10c3-3 7-1 7 3v30" class="brand-mark-body" />
    <path d="m22 35 7 7c2 2 4 2 6 0l8-7" class="brand-mark-cutout" />
    <path d="m29.5 47 10-9" class="brand-mark-neutral" />
  </svg>
</template>

<style scoped>
.brand-mark { display: block; flex: 0 0 auto; border-radius: 22%; overflow: hidden; }
.brand-mark-background { fill: #fff; }
.brand-mark-body { fill: none; stroke: #111216; stroke-width: 13; stroke-linecap: round; stroke-linejoin: round; }
.brand-mark-cutout { fill: none; stroke: #fff; stroke-width: 9; stroke-linecap: round; stroke-linejoin: round; }
.brand-mark-neutral { fill: none; stroke: #111216; stroke-width: 7; stroke-linecap: round; }
:global(:root[data-theme="dark"]) .brand-mark-background { fill: #000; }
:global(:root[data-theme="dark"]) .brand-mark-body,
:global(:root[data-theme="dark"]) .brand-mark-neutral { stroke: #fff; }
:global(:root[data-theme="dark"]) .brand-mark-cutout { stroke: #000; }
</style>
