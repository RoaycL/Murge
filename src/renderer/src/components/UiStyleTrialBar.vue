<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useUiStyleStore } from '../stores/ui-style'

const store = useUiStyleStore()
const { trialCss, trialRemaining, suspended } = storeToRefs(store)
</script>

<template>
  <Teleport to="body">
    <div v-if="trialCss !== null && !suspended" id="ui-style-trial-bar" class="ui-style-trial-bar" role="alertdialog" aria-live="assertive" aria-label="确认自定义 CSS">
      <span><strong>保留这个样式吗？</strong>{{ trialRemaining }} 秒后自动还原，按 Esc 立即还原。</span>
      <button type="button" class="trial-revert" @click="store.revertTrial()">还原</button>
      <button type="button" class="trial-keep" @click="store.keepTrial()">保留</button>
    </div>
  </Teleport>
</template>

<style scoped>
/* 刻意不用主题变量：用户 CSS 可能把变量改坏，确认条要始终可读。 */
.ui-style-trial-bar {
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  align-items: center;
  gap: 10px;
  padding: 9px 10px 9px 16px;
  border-radius: 12px;
  background: rgba(28, 30, 36, 0.94);
  color: #f4f5f7;
  font: 13px/1.4 "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.3);
  white-space: nowrap;
}
.ui-style-trial-bar strong { margin-right: 8px; font-weight: 600; }
.ui-style-trial-bar button {
  height: 28px;
  padding: 0 14px;
  border: 0;
  border-radius: 7px;
  font: inherit;
  cursor: pointer;
}
.trial-revert { background: rgba(255, 255, 255, 0.14); color: #f4f5f7; }
.trial-keep { background: #1587f8; color: #ffffff; }
</style>
