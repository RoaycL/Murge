<script setup lang="ts">
import type { BrandConfig } from '@shared/brand'
import AppIcon, { type AppIconName } from './AppIcon.vue'

defineProps<{ brand: BrandConfig }>()

const groups: Array<{ label: string; items: Array<{ to: string; label: string; icon: AppIconName }> }> = [
  {
    label: '',
    items: [
      { to: '/activity', label: '活动', icon: 'activity' },
      { to: '/overview', label: '概览', icon: 'overview' }
    ]
  },
  { label: '', items: [{ to: '/connections', label: '连接', icon: 'connections' }] },
  {
    label: '代理',
    items: [
      { to: '/policies', label: '策略', icon: 'policies' },
      { to: '/rules', label: '规则', icon: 'rules' }
    ]
  },
  {
    label: '配置',
    items: [
      { to: '/profiles', label: '配置', icon: 'profiles' },
      { to: '/overrides', label: '覆写', icon: 'overrides' },
      { to: '/resources', label: '外部资源', icon: 'resources' }
    ]
  }
]
</script>

<template>
  <aside class="app-sidebar">
    <div class="window-drag-region" />
    <nav class="sidebar-nav" aria-label="主导航">
      <section v-for="group in groups" :key="group.label || 'primary'" class="nav-section">
        <h2 v-if="group.label" class="nav-section-title">{{ group.label }}</h2>
        <RouterLink v-for="item in group.items" :key="item.to" :to="item.to" class="nav-link">
          <span class="nav-icon"><AppIcon :name="item.icon" /></span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </section>
    </nav>
    <div class="sidebar-footer">
      <RouterLink to="/more" class="nav-link"><span class="nav-icon"><AppIcon name="more" /></span><span>更多</span></RouterLink>
      <span class="visually-hidden">{{ brand.productName }}</span>
    </div>
  </aside>
</template>
