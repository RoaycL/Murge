<script setup lang="ts">
import { onMounted } from 'vue'
import { useStartupStore } from '../stores/startup'

const startup = useStartupStore()
onMounted(() => { void startup.refresh() })
</script>
<template><div class="page-shell general-view"><h1>通用</h1><section><h2>启动</h2><div class="surface-card preference-list"><label><span><strong>登录 Windows 时启动</strong><small>应用在后台启动并显示托盘图标，不会自动启动内核或代理。</small></span><input :checked="startup.status.enabled" type="checkbox" :disabled="!startup.status.supported || startup.busy" @change="startup.setEnabled(($event.target as HTMLInputElement).checked)" /></label></div><p v-if="startup.status.phase === 'unsupported'" class="setting-help">此平台不支持该设置；Windows 安装包中可用。</p><p v-else-if="startup.status.errorMessage" class="inline-error">{{ startup.status.errorMessage }}</p></section><section><h2>安全行为</h2><div class="surface-card general-info"><p>开机启动只启动桌面程序和托盘。内核、系统代理和 TUN 始终需要独立的用户操作，不会因登录而自动启用。</p></div></section></div></template>

