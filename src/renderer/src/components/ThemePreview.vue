<script setup lang="ts">
/**
 * 外观 › 主题里的示意图：一个缩小的窗口（侧栏 + 标题 + 两张卡片）。
 * 用 SVG 画而不是 CSS 渐变硬切，斜边在任何缩放比例下都是抗锯齿的平滑边。
 * 「跟随系统」把浅色和深色两个窗口沿一条斜线拼在一起。
 */
import { useId } from 'vue'

type Variant = 'light' | 'dark'
const props = defineProps<{ theme: 'system' | 'light' | 'dark' }>()
const clipId = `theme-preview-split-${useId()}`

const palettes: Record<Variant, { sidebar: string; body: string; line: string; card: string; accent: string }> = {
  light: { sidebar: '#e5ebf2', body: '#ffffff', line: '#c9d3df', card: '#f2f5f9', accent: '#1587f8' },
  dark: { sidebar: '#20242d', body: '#111318', line: '#3a414e', card: '#1b1f27', accent: '#3d9bff' }
}
const layers: Variant[] = props.theme === 'system' ? ['light', 'dark'] : [props.theme]
</script>

<template>
  <svg class="theme-preview" viewBox="0 0 240 75" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <defs v-if="theme === 'system'">
      <clipPath :id="clipId"><path d="M132 0H240V75H108Z" /></clipPath>
    </defs>
    <g v-for="(variant, index) in layers" :key="variant" :clip-path="index === 1 ? `url(#${clipId})` : undefined">
      <rect width="240" height="75" :fill="palettes[variant].body" />
      <rect width="62" height="75" :fill="palettes[variant].sidebar" />
      <rect x="10" y="14" width="30" height="5" rx="2.5" :fill="palettes[variant].accent" />
      <rect x="10" y="27" width="40" height="5" rx="2.5" :fill="palettes[variant].line" />
      <rect x="10" y="40" width="34" height="5" rx="2.5" :fill="palettes[variant].line" />
      <rect x="10" y="53" width="38" height="5" rx="2.5" :fill="palettes[variant].line" />
      <rect x="76" y="12" width="56" height="7" rx="3.5" :fill="palettes[variant].line" />
      <rect x="76" y="29" width="70" height="34" rx="6" :fill="palettes[variant].card" :stroke="palettes[variant].line" stroke-width="1" />
      <rect x="154" y="29" width="70" height="34" rx="6" :fill="palettes[variant].card" :stroke="palettes[variant].line" stroke-width="1" />
      <rect x="84" y="37" width="28" height="5" rx="2.5" :fill="palettes[variant].accent" />
      <rect x="162" y="37" width="34" height="5" rx="2.5" :fill="palettes[variant].line" />
    </g>
    <path v-if="theme === 'system'" d="M132 0L108 75" :stroke="palettes.dark.line" stroke-width="1" fill="none" />
  </svg>
</template>
