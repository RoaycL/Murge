<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import TunConfigPanel from '../components/TunConfigPanel.vue'
import TunLifecyclePanel from '../components/TunLifecyclePanel.vue'
import ProxyBypassPanel from '../components/ProxyBypassPanel.vue'
</script>
<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>网络</h1><p>配置虚拟网卡参数、TUN 服务生命周期与系统代理绕过规则；主开关位于概览页。</p></div><AppIcon name="network" :size="25" /></header><TunConfigPanel /><TunLifecyclePanel /><ProxyBypassPanel /></div></template>
