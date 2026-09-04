<script setup lang="ts">
import { computed, onMounted } from 'vue'
import OverridesPanel from '../components/OverridesPanel.vue'
import AppIcon from '../components/AppIcon.vue'
import { useProfilesStore } from '../stores/profiles'

const profiles = useProfilesStore()
const activeProfileId = computed(() => profiles.profiles.find((entry) => entry.active)?.id ?? null)
onMounted(() => void profiles.load())
</script>

<template><div class="page-shell feature-page"><header class="feature-header"><div><h1>覆写</h1><p>按顺序在配置启动前应用 YAML、脚本与规则增强。</p></div><AppIcon name="overrides" :size="25" /></header><OverridesPanel :active-profile-id="activeProfileId" /></div></template>
