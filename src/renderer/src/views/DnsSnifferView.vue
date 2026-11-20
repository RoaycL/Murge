<script setup lang="ts">
import { t } from '@shared/i18n'
import AppIcon from '../components/AppIcon.vue'
import DnsSettingsPanel from '../components/DnsSettingsPanel.vue'
import SnifferSettingsPanel from '../components/SnifferSettingsPanel.vue'
import ConfigInspectionCard from '../components/ConfigInspectionCard.vue'
import SubpageBack from '../components/SubpageBack.vue'
</script>
<template><div class="page-shell feature-page"><SubpageBack /><header class="feature-header"><div><h1>{{ t('dnsSniffer.title') }}</h1><p>{{ t('dnsSniffer.intro') }}</p></div><AppIcon name="dns" :size="25" /></header><DnsSettingsPanel /><SnifferSettingsPanel /><ConfigInspectionCard section="dns" title="DNS" /><ConfigInspectionCard section="sniffer" :title="t('dnsSniffer.sniffer')" /></div></template>
