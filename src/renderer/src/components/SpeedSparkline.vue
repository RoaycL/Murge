<script setup lang="ts">
defineProps<{
  kind: 'upload' | 'download'
  title: string
  value: string
  unit: string
  ceiling: string
  middle: string
}>()
</script>

<template>
  <SurfaceCard class="speed-card">
    <span class="metric-label">{{ title }}</span>
    <div class="speed-value">{{ value }}<span>{{ unit }}</span></div>
    <span class="speed-scale speed-scale-top">{{ ceiling }}</span>
    <span class="speed-scale speed-scale-middle">{{ middle }}</span>
    <svg class="sparkline" viewBox="0 0 165 72" preserveAspectRatio="none" role="img" :aria-label="`${title}趋势`">
      <path v-if="kind === 'upload'" class="spark-area spark-upload-area" d="M0 66 L18 66 L38 67 L58 67 L78 64 L99 66 L123 66 L165 65 L165 72 L0 72Z" />
      <path v-if="kind === 'upload'" class="spark-stroke spark-upload" d="M0 66 L18 66 L38 67 L58 67 L78 64 L99 66 L123 66 L165 65" />
      <path v-else class="spark-area spark-download-area" d="M0 66 L24 65 L48 64 L79 63 L105 67 L132 67 L165 65 L165 72 L0 72Z" />
      <path v-if="kind === 'download'" class="spark-stroke spark-download" d="M0 66 L24 65 L48 64 L79 63 L105 67 L132 67 L165 65" />
    </svg>
  </SurfaceCard>
</template>
