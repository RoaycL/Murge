<script setup lang="ts">
import AppIcon, { type AppIconName } from './AppIcon.vue'

defineProps<{ icon: AppIconName; title: string; detail?: string; actionLabel?: string }>()
defineEmits<{ action: [] }>()
</script>

<template>
  <div class="app-empty-state">
    <span class="app-empty-icon"><AppIcon :name="icon" :size="21" /></span>
    <strong>{{ title }}</strong>
    <p v-if="detail">{{ detail }}</p>
    <button v-if="actionLabel" type="button" class="secondary-button" @click="$emit('action')">{{ actionLabel }}</button>
  </div>
</template>

<style scoped>
.app-empty-state { display: flex; min-height: 150px; flex-direction: column; align-items: center; justify-content: center; padding: 24px; border: 1px dashed var(--app-divider); border-radius: 10px; color: var(--app-muted); text-align: center; }
.app-empty-icon { display: grid; width: 40px; height: 40px; margin-bottom: 10px; place-items: center; border-radius: 11px; background: color-mix(in srgb, var(--app-blue) 10%, transparent); color: var(--app-blue); }
.app-empty-state strong { color: var(--app-text); font-size: 13px; }
.app-empty-state p { max-width: 390px; margin: 5px 0 0; font-size: 11px; line-height: 1.5; }
.app-empty-state button { margin-top: 13px; }
</style>
