<script setup lang="ts">
import { t } from '@shared/i18n'
import AppIcon from '../components/AppIcon.vue'
import TunConfigPanel from '../components/TunConfigPanel.vue'
import TunLifecyclePanel from '../components/TunLifecyclePanel.vue'
import ProxyBypassPanel from '../components/ProxyBypassPanel.vue'
import ConfigInspectionCard from '../components/ConfigInspectionCard.vue'
import LanGatewayPanel from '../components/LanGatewayPanel.vue'
</script>
<template><div class="page-shell feature-page page-readable"><header class="feature-header"><div><h1>{{ t('nav.network') }}</h1><p>{{ t('network.intro') }}</p></div><AppIcon name="network" :size="25" /></header><TunConfigPanel /><TunLifecyclePanel /><LanGatewayPanel /><ProxyBypassPanel /><ConfigInspectionCard section="tun" title="TUN" /></div></template>
