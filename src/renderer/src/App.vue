<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import AppSidebar from './components/AppSidebar.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import type { BrandConfig } from '@shared/brand'
import { brand as fallbackBrand } from '@shared/brand'
import { useKernelStore } from './stores/kernel'
import { useSystemProxyStore } from './stores/system-proxy'
import { useAppearanceStore } from './stores/appearance'
import { useTunStore } from './stores/tun'

const brand = ref<BrandConfig>(fallbackBrand)
const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const appearance = useAppearanceStore()
const tun = useTunStore()

onMounted(async () => {
  appearance.connect()
  kernel.connect()
  systemProxy.connect()
  tun.connect()
  brand.value = await window.desktop.app.getBrand()
  document.title = brand.value.productName
})

onBeforeUnmount(() => {
  kernel.disconnect()
  systemProxy.disconnect()
  appearance.disconnect()
  tun.disconnect()
})
</script>

<template>
  <div class="app-window">
    <div class="app-frame">
      <AppSidebar :brand="brand" />
      <main class="app-content">
        <UpdateBanner />
        <RouterView />
      </main>
    </div>
  </div>
</template>
