<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useAppearanceStore, type ThemePreference } from '../stores/appearance'

const store = useAppearanceStore()
const { theme, highContrast, reduceMotion } = storeToRefs(store)
const themes: Array<{ value: ThemePreference; label: string; detail: string }> = [
  { value: 'system', label: '跟随系统', detail: '自动匹配 Windows 的浅色或深色外观。' },
  { value: 'light', label: '浅色', detail: '始终使用浅色界面。' },
  { value: 'dark', label: '深色', detail: '始终使用深色界面。' }
]
</script>
<template><div class="page-shell appearance-view"><h1>外观</h1><section><h2>主题</h2><div class="theme-options" role="radiogroup" aria-label="主题"><button v-for="option in themes" :key="option.value" type="button" role="radio" :aria-checked="theme === option.value" :class="{ selected: theme === option.value }" @click="store.setTheme(option.value)"><i :class="`theme-preview ${option.value}`" /><strong>{{ option.label }}</strong><span>{{ option.detail }}</span></button></div></section><section><h2>辅助功能</h2><div class="surface-card preference-list"><label><span><strong>高对比度</strong><small>增强文字、边框和当前焦点的辨识度。</small></span><button type="button" class="switch" :class="{ on: highContrast }" :aria-checked="highContrast" aria-label="高对比度" @click="store.setHighContrast(!highContrast)" /></label><label><span><strong>减少动态效果</strong><small>停用不必要的过渡和动画。</small></span><button type="button" class="switch" :class="{ on: reduceMotion }" :aria-checked="reduceMotion" aria-label="减少动态效果" @click="store.setReduceMotion(!reduceMotion)" /></label></div></section><p class="appearance-note">所有设置即时生效，并只保存在当前用户的应用数据中。</p></div></template>

