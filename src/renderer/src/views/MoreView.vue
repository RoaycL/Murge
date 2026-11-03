<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon, { type AppIconName } from '../components/AppIcon.vue'
import { useSidebarLayoutStore } from '../stores/sidebar-layout'
import type { SidebarItemId } from '../lib/sidebar-layout'

const router = useRouter()
const sidebarLayout = useSidebarLayoutStore()
// sidebar: 这一项也可以放进侧边栏（外观 › 侧边栏布局）；已在侧栏显示时这里不再重复。
const items: Array<{ label: string; description: string; to: string; icon: AppIconName; sidebar?: SidebarItemId }> = [
  { label: '通用', description: '启动、窗口、代理守护与延迟测试', to: '/general', icon: 'general' },
  { label: '外观', description: '主题、对比度、动态效果与侧边栏布局', to: '/appearance', icon: 'appearance' },
  { label: '网络', description: 'TUN、监听地址与代理绕过', to: '/network', icon: 'network' },
  { label: 'DNS 与嗅探', description: '解析模式、服务器与域名嗅探', to: '/dns-sniffer', icon: 'dns' },
  { label: '内核', description: '端口、控制器、安全与版本', to: '/kernel-settings', icon: 'kernel' },
  { label: '设备', description: '局域网接管的设备与流量', to: '/devices', icon: 'devices', sidebar: 'devices' },
  { label: 'Sub-Store', description: '订阅管理与转换', to: '/substore', icon: 'substore', sidebar: 'substore' },
  { label: '日志', description: '筛选并导出脱敏运行日志', to: '/logs', icon: 'logs' },
  { label: '关于', description: '版本、开源许可与诊断信息', to: '/about', icon: 'about' }
]
const menu = computed(() => items.filter((item) => !item.sidebar || !sidebarLayout.isVisible(item.sidebar)))
// 用户从侧栏隐藏的其他页面仍然从这里进入，避免隐藏后再也找不到。
const listed = new Set(items.map((item) => item.to))
const hiddenPages = computed(() => sidebarLayout.hidden.filter((item) => !listed.has(item.to)))
</script>
<template><div class="page-shell more-view"><h1>更多</h1><div class="settings-menu"><button v-for="item in menu" :key="item.to" type="button" @click="router.push(item.to)"><i><AppIcon :name="item.icon" :size="22" /></i><span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span><AppIcon name="next" :size="16" /></button></div><section v-if="hiddenPages.length" class="more-hidden-pages"><h2>已从侧边栏隐藏</h2><div class="settings-menu"><button v-for="item in hiddenPages" :key="item.to" type="button" @click="router.push(item.to)"><i><AppIcon :name="item.icon" :size="22" /></i><span><strong>{{ item.label }}</strong><small>可在 外观 › 侧边栏布局 中恢复显示</small></span><AppIcon name="next" :size="16" /></button></div></section></div></template>
