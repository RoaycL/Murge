<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import TunConfigPanel from '../components/TunConfigPanel.vue'
import TunLifecyclePanel from '../components/TunLifecyclePanel.vue'
import ProxyBypassPanel from '../components/ProxyBypassPanel.vue'
</script>
<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>网络</h1><p>管理 TUN 虚拟网卡、网络接管和系统代理绕过设置；开关位于概览页。</p></div><AppIcon name="network" :size="25" /></header><TunConfigPanel /><TunLifecyclePanel /><ProxyBypassPanel /></div></template>
