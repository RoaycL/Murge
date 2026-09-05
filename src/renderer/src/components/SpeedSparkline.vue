<script setup lang="ts">
import { computed } from 'vue'
import SurfaceCard from './SurfaceCard.vue'
import { formatRate } from '../lib/format'
import { trafficChartScale } from '../lib/traffic-chart-scale'

const props = defineProps<{
  kind: 'upload' | 'download'
  title: string
  value: string
  unit: string
  series: number[]
}>()

// Fixed plot box: kept identical whether data is present or not so the card
// never reflows during loading / disconnected states.
const W = 165
const H = 72
const TOP = 6
const BOTTOM = 66

const scale = computed(() => trafficChartScale(props.series))
const ceilingText = computed(() => {
  const formatted = formatRate(scale.value.ceiling)
  return `${formatted.value} ${formatted.unit}`
})
const middleText = computed(() => {
  const formatted = formatRate(scale.value.middle)
  return `${formatted.value} ${formatted.unit}`
})

const paths = computed(() => {
  const pts = props.series.length >= 2
    ? props.series
    : props.series.length === 1 ? [props.series[0], props.series[0]] : [0, 0]
  const step = W / (pts.length - 1)
  const coords = pts.map((value, index) => {
    const x = index * step
    const normalized = Math.min(1, Math.max(0, value) / scale.value.ceiling)
    const y = BOTTOM - normalized * (BOTTOM - TOP)
    return `${x.toFixed(1)} ${y.toFixed(1)}`
  })
  const stroke = `M${coords.join(' L')}`
  const area = `${stroke} L${W} ${H} L0 ${H} Z`
  return { stroke, area }
})
</script>

<template>
  <SurfaceCard class="speed-card">
    <span class="metric-label">{{ title }}</span>
    <div class="speed-value">{{ value }}<span>{{ unit }}</span></div>
    <span class="speed-scale speed-scale-top">{{ ceilingText }}</span>
    <span class="speed-scale speed-scale-middle">{{ middleText }}</span>
    <svg class="sparkline" viewBox="0 0 165 72" preserveAspectRatio="none" role="img" :aria-label="`${title}趋势`">
      <path class="spark-area" :class="kind === 'upload' ? 'spark-upload-area' : 'spark-download-area'" :d="paths.area" />
      <path class="spark-stroke" :class="kind === 'upload' ? 'spark-upload' : 'spark-download'" :d="paths.stroke" />
    </svg>
  </SurfaceCard>
</template>
