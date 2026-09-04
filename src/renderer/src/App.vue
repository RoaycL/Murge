<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import AppSidebar from './components/AppSidebar.vue'
import ToastHost from './components/ToastHost.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import type { BrandConfig } from '@shared/brand'
import { brand as fallbackBrand } from '@shared/brand'
import { useKernelStore } from './stores/kernel'
import { useSystemProxyStore } from './stores/system-proxy'
import { useAppearanceStore } from './stores/appearance'
import { useTunStore } from './stores/tun'
import { approveNavigation, cancelNavigation, pendingNavigation, unsavedLabels } from './composables/use-unsaved-changes'
import { router } from './router'

const brand = ref<BrandConfig>(fallbackBrand)
const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const appearance = useAppearanceStore()
const tun = useTunStore()

function discardAndNavigate(): void {
  const target = approveNavigation()
  if (target) void router.push(target)
}

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
        <RouterView />
      </main>
      <ToastHost />
      <ConfirmModal :open="Boolean(pendingNavigation)" title="放弃未保存的修改？" :description="`${unsavedLabels.join('、') || '当前页面'}包含尚未保存的修改，离开后将无法恢复。`" confirm-label="放弃并离开" @close="cancelNavigation" @confirm="discardAndNavigate" />
    </div>
  </div>
</template>
