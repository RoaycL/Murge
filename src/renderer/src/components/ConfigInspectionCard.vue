<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ActiveProfileConfigInspection, ProfileConfigSection } from '@shared/profiles'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ section: ProfileConfigSection; title: string }>()
const inspection = ref<ActiveProfileConfigInspection | null>(null)
const loading = ref(false)
const error = ref('')

async function refresh(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    inspection.value = await window.desktop.profiles.inspectActiveConfig()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

onMounted(() => void refresh())
</script>

<template>
  <section class="inspection-card surface-card" :aria-label="`${title}配置来源`">
    <header>
      <div><h3>{{ title }}当前生效配置</h3><p>{{ inspection?.profileName ? `活动配置：${inspection.profileName}` : '当前没有活动配置' }}</p></div>
      <button type="button" class="inspection-refresh" :disabled="loading" aria-label="刷新生效配置" @click="refresh"><AppIcon name="refresh" :size="14" /></button>
    </header>
    <p v-if="error" class="inspection-error">{{ error }}</p>
    <template v-else-if="inspection">
      <ul v-if="inspection.diagnostics.length" class="inspection-warnings" aria-label="配置兼容性提示">
        <li v-for="issue in inspection.diagnostics" :key="`${issue.line ?? 0}:${issue.message}`">
          <b>兼容性提示</b><span>{{ issue.line ? `第 ${issue.line} 行：` : '' }}{{ issue.message }}</span>
        </li>
      </ul>
      <div v-if="inspection.sections[section].managedKeys.length" class="managed-row"><b>应用接管</b><span v-for="key in inspection.sections[section].managedKeys" :key="key">{{ key }}</span></div>
      <p v-for="note in inspection.sections[section].notes" :key="note" class="inspection-note">{{ note }}</p>
      <div class="inspection-columns">
        <details><summary>配置文件值</summary><pre>{{ inspection.sections[section].profileYaml }}</pre></details>
        <details><summary>当前实际生效值</summary><pre>{{ inspection.sections[section].effectiveYaml }}</pre></details>
      </div>
    </template>
    <p v-else class="inspection-note">{{ loading ? '正在读取…' : '暂无数据' }}</p>
  </section>
</template>

<style scoped>
.inspection-card { margin-top: 18px; padding: 14px 16px; }
.inspection-card header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-5); }
.inspection-card h3 { margin: 0; font-size: var(--font-size-md); }
.inspection-card header p { margin: 3px 0 0; color: var(--app-muted); font-size: var(--font-size-2xs); }
.inspection-refresh { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: transparent; color: var(--app-muted); }
.inspection-warnings { display: grid; gap: var(--space-2); margin: 11px 0 0; padding: 0; list-style: none; }
.inspection-warnings li { display: flex; align-items: flex-start; gap: var(--space-3); padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--app-warning) 38%, var(--app-divider)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--app-warning) 8%, transparent); color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.45; }
.inspection-warnings b { flex: 0 0 auto; color: var(--app-warning); }
.managed-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-top: 11px; font-size: var(--font-size-2xs); }
.managed-row b { color: var(--app-purple); }
.managed-row span { padding: 3px 7px; border: 1px solid var(--app-divider); border-radius: var(--radius-pill); background: var(--app-fill-subtle); }
.inspection-note { margin: 8px 0 0; color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.45; }
.inspection-columns { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-4); margin-top: 10px; }
.inspection-columns details { min-width: 0; border: 1px solid var(--app-divider); border-radius: var(--radius-control); overflow: hidden; }
.inspection-columns summary { padding: 8px 10px; cursor: pointer; color: var(--app-muted); font-size: var(--font-size-xs); }
.inspection-columns pre { max-height: 220px; margin: 0; padding: 10px; overflow: auto; border-top: 1px solid var(--app-divider); background: var(--app-fill-subtle); font: 10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.inspection-error { color: var(--app-danger); font-size: var(--font-size-xs); }
@media (max-width: 720px) { .inspection-columns { grid-template-columns: 1fr; } }
</style>
