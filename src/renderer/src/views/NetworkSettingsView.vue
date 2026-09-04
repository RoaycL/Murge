<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import TunConfigPanel from '../components/TunConfigPanel.vue'
import TunLifecyclePanel from '../components/TunLifecyclePanel.vue'
import ProxyBypassPanel from '../components/ProxyBypassPanel.vue'
</script>
<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>网络</h1><p>配置 TUN 生命周期、虚拟网卡参数与代理绕过；主开关仍位于概览。</p></div><AppIcon name="network" :size="25" /></header><TunConfigPanel /><TunLifecyclePanel /><ProxyBypassPanel /></div></template>
