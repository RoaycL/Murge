<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import DnsSettingsPanel from '../components/DnsSettingsPanel.vue'
import SnifferSettingsPanel from '../components/SnifferSettingsPanel.vue'
</script>
<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>DNS 与嗅探</h1><p>配置解析模式、服务器、Fake IP 与域名嗅探参数。</p></div><AppIcon name="dns" :size="25" /></header><DnsSettingsPanel /><SnifferSettingsPanel /></div></template>
