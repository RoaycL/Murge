<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AppInfo } from '@shared/app-info'
import type { BrandConfig } from '@shared/brand'
import { serializeDiagnosticBundle, type DiagnosticInput } from '../lib/diagnostics'

const brand = ref<BrandConfig | null>(null)
const info = ref<AppInfo | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    ;[brand.value, info.value] = await Promise.all([window.desktop.app.getBrand(), window.desktop.app.getInfo()])
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
})

async function exportDiagnostics(): Promise<void> {
  if (!brand.value || !info.value) return
  busy.value = true; error.value = null
  try {
    const settled = await Promise.allSettled([
      window.desktop.kernel.getStatus(), window.desktop.systemProxy.getStatus(), window.desktop.startup.getStatus(), window.desktop.tun.getStatus()
    ])
    const value = <T,>(index: number): T | null => settled[index].status === 'fulfilled' ? settled[index].value as T : null
    const input: DiagnosticInput = { brand: brand.value, app: info.value, kernel: value(0), systemProxy: value(1), startup: value(2), tun: value(3), kernelVersion: null }
    const blob = new Blob([serializeDiagnosticBundle(input)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `${brand.value.executableName}-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; anchor.click(); URL.revokeObjectURL(url)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = false }
}
</script>

<template><div class="page-shell about-view"><h1>关于</h1>
  <section class="surface-card about-product"><strong>{{ brand?.productName ?? '—' }}</strong><span>版本 {{ info?.version ?? '—' }} · {{ info?.platform ?? '—' }} / {{ info?.arch ?? '—' }}</span><p>{{ brand?.description }}</p></section>
  <section><h2>支持</h2><div class="surface-card preference-list">
    <a v-if="brand?.repositoryUrl" :href="brand.repositoryUrl" target="_blank" rel="noreferrer"><span><strong>源代码仓库</strong><small>{{ brand.repositoryUrl }}</small></span><b>打开</b></a>
    <a v-if="brand?.supportUrl" :href="brand.supportUrl" target="_blank" rel="noreferrer"><span><strong>问题与支持</strong><small>{{ brand.supportUrl }}</small></span><b>打开</b></a>
  </div></section>
  <section><h2>诊断</h2><div class="surface-card general-info"><p>诊断包仅包含版本、平台和功能状态；不会包含配置、订阅、控制器地址、密钥、日志或用户路径。</p><button type="button" :disabled="busy || !info" @click="exportDiagnostics">导出诊断包</button></div><p v-if="error" class="inline-error">{{ error }}</p></section>
  <small class="about-copyright">{{ brand?.copyright }}</small>
</div></template>
