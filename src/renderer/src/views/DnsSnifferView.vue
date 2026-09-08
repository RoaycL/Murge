<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import DnsSettingsPanel from '../components/DnsSettingsPanel.vue'
import SnifferSettingsPanel from '../components/SnifferSettingsPanel.vue'
import ConfigInspectionCard from '../components/ConfigInspectionCard.vue'
</script>
<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>DNS 与嗅探</h1><p>设置内核 DNS 解析、虚拟 IP、上游服务器、域名分流及嗅探规则，主开关位于概览页。</p></div><AppIcon name="dns" :size="25" /></header><ConfigInspectionCard section="dns" title="DNS" /><DnsSettingsPanel /><ConfigInspectionCard section="sniffer" title="嗅探" /><SnifferSettingsPanel /></div></template>
