<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import AppSidebar from './components/AppSidebar.vue'
import type { BrandConfig } from '@shared/brand'
import { brand as fallbackBrand } from '@shared/brand'

const brand = ref<BrandConfig>(fallbackBrand)

onMounted(async () => {
  brand.value = await window.desktop.app.getBrand()
  document.title = brand.value.productName
})
</script>

<template>
  <div class="app-window">
    <div class="app-frame">
      <AppSidebar :brand="brand" />
      <main class="app-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>
