<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useTunStore } from '../stores/tun'
import { TUN_UI_COPY } from '@shared/tun'
import { tunLifecycleDetail, tunLifecycleGating } from '../lib/tun-lifecycle'

const tun = useTunStore()

const phase = computed(() => tun.status.phase)
const gating = computed(() => tunLifecycleGating(tun.status, tun.busy))
const phaseLabel = computed(() => TUN_UI_COPY[phase.value])
const detail = computed(() => tunLifecycleDetail(tun.status))

onMounted(() => tun.connect())
onBeforeUnmount(() => tun.disconnect())
</script>

<template>
  <section class="tunlife-panel" aria-label="TUN 生命周期">
    <header class="tunlife-head">
      <div>
        <h2 class="tunlife-title">TUN 状态</h2>
        <p class="tunlife-subtitle">
          启用 mihomo 自营 TUN 适配器（独立于安全直连内核与系统代理）。启用前需停止内核与系统代理；禁用会恢复系统网络设置。当前构建标记为
          <code>implementation-complete / runtime-unverified</code>，未启用 Windows 服务运输。
        </p>
      </div>
      <div class="tunlife-status" :class="{ active: gating.active }">
        <i class="tunlife-dot" />
        <span>{{ phaseLabel }}</span>
      </div>
    </header>

    <p v-if="tun.actionError" class="inline-error" role="alert">{{ tun.actionError }}</p>
    <p v-if="gating.showConflict" class="inline-error" role="alert">检测到网络配置被外部修改：{{ detail }}</p>
    <p v-if="gating.showError" class="inline-error" role="alert">{{ detail }}</p>
    <p v-if="gating.showUnsupported" class="tunlife-note">
      当前平台不支持 TUN（需要在受支持的 Windows 构建上启用），相关配置编辑仍会保存在本地。
    </p>

    <div class="tunlife-actions">
      <button type="button" class="tunlife-enable" :disabled="!gating.canEnable" :aria-label="gating.enableLabel" @click="tun.enable()">
        {{ gating.busyPhase ? '处理中…' : gating.enableLabel }}
      </button>
      <button type="button" class="tunlife-disable" :disabled="!gating.canDisable" :aria-label="'禁用 TUN'" @click="tun.disable()">
        {{ phase === 'restoring' ? '恢复中…' : '禁用' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.tunlife-panel {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
}
.tunlife-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.tunlife-title { margin: 0 0 4px; font-size: 15px; }
.tunlife-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.tunlife-subtitle code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--app-surface-solid);
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tunlife-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 999px;
  background: var(--app-panel);
  color: var(--app-muted);
  font-size: 11px;
  white-space: nowrap;
}
.tunlife-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(127, 127, 127, 0.38);
}
.tunlife-status.active { color: inherit; }
.tunlife-status.active .tunlife-dot { background: var(--app-blue); }
.tunlife-note { margin: 10px 0 0; color: var(--app-muted); font-size: 11px; }
.tunlife-actions { margin-top: 14px; display: flex; gap: 8px; }
.tunlife-enable,
.tunlife-disable {
  min-height: 34px;
  padding: 0 18px;
  border: 0;
  border-radius: 8px;
  font-size: 12px;
}
.tunlife-enable { background: var(--app-blue); color: white; }
.tunlife-disable { background: rgba(127, 127, 127, 0.14); color: inherit; }
.tunlife-enable:disabled,
.tunlife-disable:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
