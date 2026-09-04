<script setup lang="ts">
import { useRouter } from 'vue-router'
import AppIcon, { type AppIconName } from '../components/AppIcon.vue'

const router = useRouter()
const items: Array<{ label: string; description: string; to: string; icon: AppIconName }> = [
  { label: '通用', description: '启动、托盘、更新与通知', to: '/general', icon: 'general' },
  { label: '网络', description: 'TUN、监听地址与代理绕过', to: '/network', icon: 'network' },
  { label: 'DNS 与嗅探', description: '解析模式、服务器与域名嗅探', to: '/dns-sniffer', icon: 'dns' },
  { label: '内核', description: '端口、控制器、安全与版本', to: '/kernel-settings', icon: 'kernel' },
  { label: '外观', description: '主题、对比度和动态效果', to: '/appearance', icon: 'appearance' },
  { label: '日志', description: '筛选并导出脱敏运行日志', to: '/logs', icon: 'logs' },
  { label: '关于', description: '版本、开源许可与诊断信息', to: '/about', icon: 'about' }
]
</script>
<template><div class="page-shell more-view"><h1>更多</h1><div class="settings-menu"><button v-for="item in items" :key="item.to" type="button" @click="router.push(item.to)"><i><AppIcon :name="item.icon" :size="22" /></i><span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span><AppIcon name="next" :size="16" /></button></div></div></template>
