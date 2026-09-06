<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import DnsSettingsPanel from '../components/DnsSettingsPanel.vue'
import SnifferSettingsPanel from '../components/SnifferSettingsPanel.vue'
</script>
<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>DNS 与嗅探</h1><p>接管内核 DNS 解析与域名嗅探：Fake-IP 模式、上游服务器、分流策略与嗅探端口/跳过规则，主开关位于概览页。</p></div><AppIcon name="dns" :size="25" /></header><DnsSettingsPanel /><SnifferSettingsPanel /></div></template>
