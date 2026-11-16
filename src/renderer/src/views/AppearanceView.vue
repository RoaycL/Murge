<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useAppearanceStore, type ThemePreference } from '../stores/appearance'
import { useSidebarLayoutStore } from '../stores/sidebar-layout'
import SidebarLayoutEditor from '../components/SidebarLayoutEditor.vue'

const store = useAppearanceStore()
const sidebarLayout = useSidebarLayoutStore()
const { theme, highContrast, reduceMotion, translucent } = storeToRefs(store)
const backdropSupported = store.backdrop !== 'none'
const translucentDetail = computed(() => !backdropSupported
  ? t('appearance.micaNeedWin11')
  : highContrast.value ? t('appearance.micaHighContrast') : t('appearance.micaHint'))
const themes: Array<{ value: ThemePreference; label: string; detail: string }> = [
  { value: 'system', label: t('common.followSystem'), detail: t('appearance.themeSystemHint') },
  { value: 'light', label: t('appearance.themeLight'), detail: t('appearance.themeLightHint') },
  { value: 'dark', label: t('appearance.themeDark'), detail: t('appearance.themeDarkHint') }
]
</script>
<template><div class="page-shell appearance-view"><h1>{{ t('appearance.title') }}</h1><section><h2>{{ t('appearance.theme') }}</h2><div class="theme-options" role="radiogroup" :aria-label="t('appearance.theme')"><button v-for="option in themes" :key="option.value" type="button" role="radio" :aria-checked="theme === option.value" :class="{ selected: theme === option.value }" @click="store.setTheme(option.value)"><i :class="`theme-preview ${option.value}`" /><strong>{{ option.label }}</strong><span>{{ option.detail }}</span></button></div></section><section><h2>{{ t('appearance.window') }}</h2><div class="surface-card preference-list"><label><span><strong>{{ t('appearance.frosted') }}</strong><small>{{ translucentDetail }}</small></span><button type="button" class="switch" :class="{ on: backdropSupported && translucent }" :aria-checked="backdropSupported && translucent" :aria-label="t('appearance.frosted')" :disabled="!backdropSupported" @click="store.setTranslucent(!translucent)" /></label></div></section><section><h2>{{ t('appearance.accessibility') }}</h2><div class="surface-card preference-list"><label><span><strong>{{ t('appearance.highContrast') }}</strong><small>{{ t('appearance.highContrastHint') }}</small></span><button type="button" class="switch" :class="{ on: highContrast }" :aria-checked="highContrast" :aria-label="t('appearance.highContrast')" @click="store.setHighContrast(!highContrast)" /></label><label><span><strong>{{ t('appearance.reduceMotion') }}</strong><small>{{ t('appearance.reduceMotionHint') }}</small></span><button type="button" class="switch" :class="{ on: reduceMotion }" :aria-checked="reduceMotion" :aria-label="t('appearance.reduceMotion')" @click="store.setReduceMotion(!reduceMotion)" /></label></div></section><section class="sidebar-layout-section"><div class="section-heading"><h2>{{ t('appearance.sidebarLayout') }}</h2><button type="button" class="secondary-button" :disabled="sidebarLayout.isDefault" @click="sidebarLayout.reset()">{{ t('common.restoreDefaults') }}</button></div><p class="section-hint">{{ t('appearance.sidebarLayoutHint') }}</p><SidebarLayoutEditor /></section><p class="appearance-note">{{ t('appearance.footer') }}</p></div></template>

