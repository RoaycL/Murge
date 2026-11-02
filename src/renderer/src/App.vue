<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppSidebar from './components/AppSidebar.vue'
import ToastHost from './components/ToastHost.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import type { BrandConfig } from '@shared/brand'
import { brand as fallbackBrand } from '@shared/brand'
import { useKernelStore } from './stores/kernel'
import { useSystemProxyStore } from './stores/system-proxy'
import { useAppearanceStore } from './stores/appearance'
import { useTunStore } from './stores/tun'
import { useTrafficStore } from './stores/traffic'
import { useConnectionsStore } from './stores/connections'
import { approveNavigation, cancelNavigation, pendingNavigation, unsavedLabels } from './composables/use-unsaved-changes'
import { router } from './router'

const brand = ref<BrandConfig>(fallbackBrand)
const route = useRoute()
// 与 Surge 一致：活动、概览、配置这类卡片主页整窗是一整块背景（侧栏与内容不分层），
// 其他页面的内容区是浮在窗口底上的叠加面板。
const FLAT_SURFACE_ROUTES = ['/activity', '/overview', '/profiles']
const contentSurface = computed(() => FLAT_SURFACE_ROUTES.includes(route.path) ? 'flat' : 'panel')
// 活动（首页）与概览只是一屏卡片，偶尔多出几像素就冒出滚动条；隐藏它，内容仍可滚动。
const HIDDEN_SCROLLBAR_ROUTES = ['/activity', '/overview']
const contentScrollbar = computed(() => HIDDEN_SCROLLBAR_ROUTES.includes(route.path) ? 'hidden' : 'auto')
const kernel = useKernelStore()
const systemProxy = useSystemProxyStore()
const appearance = useAppearanceStore()
const tun = useTunStore()
const traffic = useTrafficStore()
const connections = useConnectionsStore()
let unsubscribeNavigation: (() => void) | null = null

function discardAndNavigate(): void {
  const target = approveNavigation()
  if (target) void router.push(target)
}

onMounted(async () => {
  unsubscribeNavigation = window.desktop.app.onNavigate((path) => { void router.push(path) })
  appearance.connect()
  kernel.connect()
  systemProxy.connect()
  tun.connect()
  traffic.connect()
  connections.connect()
  brand.value = await window.desktop.app.getBrand()
  document.title = brand.value.productName
})

onBeforeUnmount(() => {
  unsubscribeNavigation?.()
  unsubscribeNavigation = null
  kernel.disconnect()
  systemProxy.disconnect()
  appearance.disconnect()
  tun.disconnect()
  traffic.disconnect()
  connections.disconnect()
})
</script>

<template>
  <div class="app-window">
    <div class="app-frame" :data-surface="contentSurface" :data-scrollbar="contentScrollbar">
      <AppSidebar :brand="brand" />
      <main class="app-content">
        <RouterView />
      </main>
      <ToastHost />
      <UpdateDialog />
      <ConfirmModal :open="Boolean(pendingNavigation)" title="放弃未保存的修改？" :description="`${unsavedLabels.join('、') || '当前页面'}包含尚未保存的修改，离开后将无法恢复。`" confirm-label="放弃并离开" @close="cancelNavigation" @confirm="discardAndNavigate" />
    </div>
  </div>
</template>
