<script setup lang="ts">
/**
 * 「更多」下二级页面（通用、外观、网络……）标题上方的返回入口。
 * 有上一页（从「更多」或概览进来）就回到上一页；没有（托盘或通知直接打开）就回「更多」。
 */
import { t } from '@shared/i18n'
import { useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'

const router = useRouter()

function goBack(): void {
  const back = router.options.history.state.back
  if (typeof back === 'string' && back) router.back()
  else void router.push('/more')
}
</script>

<template>
  <button type="button" class="subpage-back" @click="goBack">
    <AppIcon name="back" :size="15" :stroke-width="2.2" /><span>{{ t('common.back') }}</span>
  </button>
</template>
