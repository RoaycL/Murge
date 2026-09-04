<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import CoreSettingsPanel from '../components/CoreSettingsPanel.vue'
import KernelVersionModal from '../components/KernelVersionModal.vue'
import { useKernelManagerStore } from '../stores/kernel-manager'
import AppSelect from '../components/AppSelect.vue'

const manager = useKernelManagerStore()
const showVersions = ref(false)
let unsubscribe: (() => void) | null = null
onMounted(() => { void manager.refresh(); unsubscribe = manager.subscribe() })
onBeforeUnmount(() => unsubscribe?.())
function changeChannel(value: string): void { if (value === 'specific') showVersions.value = true; else void manager.setChannel('stable') }
</script>
<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>内核</h1><p>管理 mihomo 版本、控制器、监听端口与安全选项。</p></div><AppIcon name="kernel" :size="25" /></header><section class="surface-card kernel-version-card"><div><span>当前内核</span><strong>{{ manager.state.effectiveVersion || manager.state.stableVersion || '内置稳定版' }}</strong><small>{{ manager.state.channel === 'specific' ? '指定版本' : '稳定版' }}</small></div><div class="kernel-version-actions"><AppSelect :model-value="manager.state.channel" :options="[{ value: 'stable', label: '稳定版' }, { value: 'specific', label: '指定版本…' }]" label="内核版本" @update:model-value="changeChannel" /><button type="button" class="secondary-button" @click="showVersions = true"><AppIcon name="download" :size="15" />管理版本</button><button type="button" class="switch" :class="{ on: manager.state.enabled }" :aria-checked="manager.state.enabled" aria-label="启用内核" @click="manager.setEnabled(!manager.state.enabled)" /></div></section><p v-if="manager.errorMessage" class="inline-error">{{ manager.errorMessage }}</p><CoreSettingsPanel /><KernelVersionModal v-if="showVersions" @close="showVersions = false" /></div></template>
