<script setup lang="ts">
import { computed } from 'vue'
import type { BrandConfig } from '@shared/brand'
import AppIcon from './AppIcon.vue'
import AppTitlebar from './AppTitlebar.vue'
import { detectShell } from '../platform/desktop-contract'
import { useSidebarLayoutStore } from '../stores/sidebar-layout'

const isTauri = detectShell().kind === 'tauri'

defineProps<{ brand: BrandConfig }>()

// 侧栏条目、分组与默认顺序见 lib/sidebar-layout.ts；用户在「外观 › 侧边栏布局」里调整。
const sidebarLayout = useSidebarLayoutStore()
const groups = computed(() => sidebarLayout.groups)
</script>

<template>
  <aside class="app-sidebar">
    <div class="window-drag-region" :data-tauri-drag-region="isTauri ? '' : undefined" />
    <AppTitlebar v-if="isTauri" />
    <nav class="sidebar-nav" aria-label="主导航">
      <section v-for="group in groups" :key="group.id" class="nav-section">
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
