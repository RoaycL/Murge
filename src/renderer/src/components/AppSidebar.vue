<script setup lang="ts">
import type { BrandConfig } from '@shared/brand'

defineProps<{ brand: BrandConfig }>()

const groups = [
  {
    label: '',
    items: [
      { to: '/activity', label: '活动', icon: '⌁' },
      { to: '/overview', label: '概览', icon: '⌘' }
    ]
  },
  {
    label: '客户端',
    items: [
      { to: '/processes', label: '进程', icon: '▣' },
      { to: '/devices', label: '设备', icon: '▤' }
    ]
  },
  {
    label: '代理',
    items: [
      { to: '/policies', label: '策略', icon: '⑂' },
      { to: '/rules', label: '规则', icon: '☷' }
    ]
  },
  {
    label: 'HTTP',
    items: [
      { to: '/capture', label: '捕获', icon: '⌗' },
      { to: '/decrypt', label: '解密', icon: '♙' },
      { to: '/rewrite', label: '重写', icon: '〆' }
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
          <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </section>
    </nav>
    <div class="sidebar-footer">
      <RouterLink to="/more" class="nav-link"><span class="nav-icon">☷</span><span>更多</span></RouterLink>
      <button class="nav-link sidebar-button" type="button"><span class="nav-icon">◉</span><span>面板</span></button>
      <span class="visually-hidden">{{ brand.productName }}</span>
    </div>
  </aside>
</template>
