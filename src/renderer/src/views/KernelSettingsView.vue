<script setup lang="ts">
import { t } from '@shared/i18n'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import CoreSettingsPanel from '../components/CoreSettingsPanel.vue'
import KernelVersionModal from '../components/KernelVersionModal.vue'
import { useKernelManagerStore } from '../stores/kernel-manager'
import AppSelect from '../components/AppSelect.vue'
import ConfigInspectionCard from '../components/ConfigInspectionCard.vue'
import SubpageBack from '../components/SubpageBack.vue'

const manager = useKernelManagerStore()
const showVersions = ref(false)
let unsubscribe: (() => void) | null = null
onMounted(() => { void manager.refresh(); unsubscribe = manager.subscribe() })
onBeforeUnmount(() => unsubscribe?.())
function changeChannel(value: string): void {
  if (value === 'specific' && manager.state.specificVersionsSupported) showVersions.value = true
  else if (value === 'stable' || value === 'preview' || value === 'smart') void manager.setChannel(value)
}
function toggleSmart(): void { void manager.setEnabled(!manager.state.smartEnabled) }
</script>
<template><div class="page-shell feature-page"><SubpageBack :title="t('kernel.title')" /><header class="feature-header"><div><h1>{{ t('kernel.title') }}</h1><p>{{ t('kernel.intro') }}</p></div><AppIcon name="kernel" :size="25" /></header><section class="surface-card kernel-version-card"><div><span>{{ t('kernel.current') }}</span><strong>{{ manager.state.effectiveVersion || manager.state.stableVersion || t('kernelVersion.builtinStable') }}</strong><small>{{ manager.state.channel === 'specific' ? t('kernel.specific') : manager.state.channel === 'preview' ? t('kernel.preview') : manager.state.channel === 'smart' ? t('kernel.smart') : t('updateDialog.stable') }}</small></div><div class="kernel-version-actions"><label class="smart-kernel-toggle"><span>{{ t('kernel.enableSmart') }}</span><button type="button" class="switch" :class="{ on: manager.state.smartEnabled }" :aria-checked="manager.state.smartEnabled" :disabled="manager.busy" :aria-label="t('kernel.enableSmart')" @click="toggleSmart" /></label><AppSelect v-if="manager.state.specificVersionsSupported" :model-value="manager.state.channel" :options="[{ value: 'stable', label: t('updateDialog.stable') }, { value: 'preview', label: t('kernel.preview') }, ...(manager.state.smartEnabled ? [{ value: 'smart', label: t('kernel.smart') }] : []), { value: 'specific', label: t('kernel.specificEllipsis') }]" :label="t('kernel.versionLabel')" @update:model-value="changeChannel" /><button type="button" class="secondary-button" @click="showVersions = true"><AppIcon name="download" :size="15" />{{ t('kernel.manage') }}</button></div></section><p v-if="manager.state.installing" class="setting-help">{{ t('kernel.preparing', [manager.state.installing === 'smart' ? ' Smart' : manager.state.installing === 'preview' ? t('kernel.previewShort') : ` ${manager.state.installing}`]) }}</p><p v-if="manager.errorMessage" class="inline-error">{{ manager.errorMessage }}</p><CoreSettingsPanel /><ConfigInspectionCard section="core" :title="t('logScope.kernel')" /><KernelVersionModal v-if="showVersions" @close="showVersions = false" /></div></template>
<style scoped>.smart-kernel-toggle{display:flex;align-items:center;gap:var(--space-3);color:var(--app-muted);font-size:var(--font-size-xs);white-space:nowrap}</style>
