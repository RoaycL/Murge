<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon, { type AppIconName } from '../components/AppIcon.vue'
import { useSidebarLayoutStore } from '../stores/sidebar-layout'
import type { SidebarItemId } from '../lib/sidebar-layout'

const router = useRouter()
const sidebarLayout = useSidebarLayoutStore()
const items: Array<{ label: string; description: string; to: string; icon: AppIconName }> = [
  { label: t('nav.general'), description: t('more.generalHint'), to: '/general', icon: 'general' },
  { label: t('nav.appearance'), description: t('more.appearanceHint'), to: '/appearance', icon: 'appearance' },
  { label: t('nav.network'), description: t('more.networkHint'), to: '/network', icon: 'network' },
  { label: t('nav.dnsSniffer'), description: t('more.dnsHint'), to: '/dns-sniffer', icon: 'dns' },
  { label: t('nav.kernel'), description: t('more.kernelHint'), to: '/kernel-settings', icon: 'kernel' },
  { label: t('nav.logs'), description: t('more.logsHint'), to: '/logs', icon: 'logs' },
  { label: t('nav.about'), description: t('more.aboutHint'), to: '/about', icon: 'about' }
]
// 不在侧栏里的页面（默认是设备与 Sub-Store）从这里进入，隐藏后也不会找不到。
const descriptions: Partial<Record<SidebarItemId, string>> = {
  devices: t('more.devicesHint'),
  substore: t('more.subStoreHint')
}
const hiddenPages = computed(() => sidebarLayout.hidden.map((item) => ({ ...item, description: descriptions[item.id] ?? t('more.hiddenHint') })))
</script>
<template><div class="page-shell more-view"><h1>{{ t('common.more') }}</h1><div class="settings-menu"><button v-for="item in items" :key="item.to" type="button" @click="router.push(item.to)"><i><AppIcon :name="item.icon" :size="22" /></i><span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span><AppIcon name="next" :size="16" /></button></div><section v-if="hiddenPages.length" class="more-hidden-pages"><h2>{{ t('more.hidden') }}</h2><div class="settings-menu"><button v-for="item in hiddenPages" :key="item.to" type="button" @click="router.push(item.to)"><i><AppIcon :name="item.icon" :size="22" /></i><span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span><AppIcon name="next" :size="16" /></button></div></section></div></template>
