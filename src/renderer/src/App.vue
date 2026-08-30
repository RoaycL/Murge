<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import AppSidebar from './components/AppSidebar.vue'
import type { BrandConfig } from '@shared/brand'
import { brand as fallbackBrand } from '@shared/brand'
import { useKernelStore } from './stores/kernel'
import { useSystemProxyStore } from './stores/system-proxy'
import { useAppearanceStore } from './stores/appearance'

const brand = ref<BrandConfig>(fallbackBrand)
const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const appearance = useAppearanceStore()

onMounted(async () => {
  appearance.connect()
  kernel.connect()
  systemProxy.connect()
  brand.value = await window.desktop.app.getBrand()
  document.title = brand.value.productName
})

onBeforeUnmount(() => {
  kernel.disconnect()
  systemProxy.disconnect()
  appearance.disconnect()
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
