<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import CoreSettingsPanel from '../components/CoreSettingsPanel.vue'
import KernelVersionModal from '../components/KernelVersionModal.vue'
import { useKernelManagerStore } from '../stores/kernel-manager'
import AppSelect from '../components/AppSelect.vue'
import ConfigInspectionCard from '../components/ConfigInspectionCard.vue'

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
<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>内核</h1><p>内核始终跟随应用运行，并可切换稳定、预览、Smart 或指定版本。</p></div><AppIcon name="kernel" :size="25" /></header><section class="surface-card kernel-version-card"><div><span>当前内核</span><strong>{{ manager.state.effectiveVersion || manager.state.stableVersion || '内置稳定版' }}</strong><small>{{ manager.state.channel === 'specific' ? '指定版本' : manager.state.channel === 'preview' ? '预览版' : manager.state.channel === 'smart' ? 'Smart 内核' : '稳定版' }}</small></div><div class="kernel-version-actions"><label class="smart-kernel-toggle"><span>启用 Smart 内核</span><button type="button" class="switch" :class="{ on: manager.state.smartEnabled }" :aria-checked="manager.state.smartEnabled" :disabled="manager.busy" aria-label="启用 Smart 内核" @click="toggleSmart" /></label><AppSelect v-if="manager.state.specificVersionsSupported" :model-value="manager.state.channel" :options="[{ value: 'stable', label: '稳定版' }, { value: 'preview', label: '预览版' }, ...(manager.state.smartEnabled ? [{ value: 'smart', label: 'Smart 内核' }] : []), { value: 'specific', label: '指定版本…' }]" label="内核版本" @update:model-value="changeChannel" /><button type="button" class="secondary-button" @click="showVersions = true"><AppIcon name="download" :size="15" />管理版本</button></div></section><p v-if="manager.state.installing" class="setting-help">正在准备{{ manager.state.installing === 'smart' ? ' Smart' : manager.state.installing === 'preview' ? '预览' : ` ${manager.state.installing}` }}内核…</p><p v-if="manager.errorMessage" class="inline-error">{{ manager.errorMessage }}</p><ConfigInspectionCard section="core" title="内核" /><CoreSettingsPanel /><KernelVersionModal v-if="showVersions" @close="showVersions = false" /></div></template>
<style scoped>.smart-kernel-toggle{display:flex;align-items:center;gap:8px;color:var(--app-muted);font-size:11px;white-space:nowrap}</style>
