<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{ src?: string; alt?: string; cacheKey?: string }>()
// Module-scoped mirror avoids a one-frame blank when a policy list is rebuilt
// in the same renderer session; the main-process cache remains authoritative.
const memoryCache = new Map<string, string>()
const source = ref<string | null>(null)
let generation = 0
let activeKey = ''

watch(() => [props.src, props.cacheKey] as const, async ([url, semanticKey]) => {
  const current = ++generation
  const cacheKey = semanticKey?.trim() || url || ''
  if (!cacheKey) {
    activeKey = ''
    source.value = null
    return
  }
  if (activeKey !== cacheKey) {
    activeKey = cacheKey
    source.value = memoryCache.get(cacheKey) ?? null
  }
  if (url?.startsWith('data:image/')) {
    source.value = url
    memoryCache.set(cacheKey, url)
    return
  }
  const cached = await window.desktop.app.getCachedIcon(cacheKey, undefined, false).catch(() => null)
  if (current !== generation) return
  if (cached) {
    source.value = cached
    memoryCache.set(cacheKey, cached)
  }
  if (!url) return
  const refreshed = await window.desktop.app.getCachedIcon(cacheKey, url, true).catch(() => null)
  if (current === generation && refreshed) {
    source.value = refreshed
    memoryCache.set(cacheKey, refreshed)
  }
}, { immediate: true })
</script>

<template><img v-if="source" :src="source" :alt="alt ?? ''" /></template>
