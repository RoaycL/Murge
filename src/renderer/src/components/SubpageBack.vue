<script setup lang="ts">
/**
 * 「更多」下二级页面（通用、外观、网络……）顶部的导航栏，做法同 iOS 设置：
 * 返回键一直贴在内容面板顶部；页面往下滚、大标题滑到栏下面后，栏变成半透明毛玻璃，
 * 中间淡入当前页的名称。回到顶部时恢复成透明的一行返回键。
 * 返回：有上一页（从「更多」或概览进来）就回到上一页；没有（托盘或通知直接打开）就回「更多」。
 */
import { t } from '@shared/i18n'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'

defineProps<{ title: string }>()

const router = useRouter()
const bar = ref<HTMLElement | null>(null)
/** 内容已经滚到栏下面：显示毛玻璃底和分隔线。 */
const scrolled = ref(false)
/** 页面大标题已经滚过栏底：栏中间显示页名。 */
const titleShown = ref(false)
let scroller: HTMLElement | null = null
let heading: HTMLElement | null = null
let frame = 0

function goBack(): void {
  const back = router.options.history.state.back
  if (typeof back === 'string' && back) router.back()
  else void router.push('/more')
}

function update(): void {
  frame = 0
  if (!scroller || !bar.value) return
  scrolled.value = scroller.scrollTop > 1
  if (!heading?.isConnected) heading = bar.value.parentElement?.querySelector('h1') ?? null
  if (!heading) { titleShown.value = scrolled.value; return }
  // 标题过半藏到栏下面就切换，和 iOS 大标题收起的时机接近。
  const barBottom = bar.value.getBoundingClientRect().bottom
  const rect = heading.getBoundingClientRect()
  titleShown.value = rect.top + rect.height / 2 < barBottom
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(update)
}

onMounted(() => {
  scroller = bar.value?.closest<HTMLElement>('.app-content') ?? null
  scroller?.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
  update()
})

onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', schedule)
  window.removeEventListener('resize', schedule)
  if (frame) cancelAnimationFrame(frame)
})
</script>

<template>
  <!-- 栏覆盖在窗口拖动区上方，所以它自己的空白处也能拖动窗口、双击最大化。 -->
  <div ref="bar" class="subpage-bar" :class="{ scrolled, 'title-shown': titleShown }" data-tauri-drag-region>
    <button type="button" class="subpage-back" :aria-label="t('common.back')" :title="t('common.back')" @click="goBack">
      <AppIcon name="back" :size="17" :stroke-width="2.2" />
    </button>
    <strong class="subpage-bar-title" :aria-hidden="!titleShown">{{ title }}</strong>
  </div>
</template>
