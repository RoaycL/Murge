<script setup lang="ts">
import { computed } from 'vue'
import { useTunStore } from '../stores/tun'
import { useProfilesStore } from '../stores/profiles'
import { TUN_DATA_PLANE_UNCONFIRMED, TUN_UI_COPY } from '@shared/tun'
import { tunLifecycleDetail, tunLifecycleGating } from '../lib/tun-lifecycle'

const tun = useTunStore()
const profiles = useProfilesStore()

const phase = computed(() => tun.status.phase)
const gating = computed(() => tunLifecycleGating(tun.status, tun.busy))
const phaseLabel = computed(() => (
  phase.value === 'active' && tun.status.errorMessage === TUN_DATA_PLANE_UNCONFIRMED
    ? '已启用 · 连通性未确认'
    : TUN_UI_COPY[phase.value]
))
const detail = computed(() => tunLifecycleDetail(tun.status))

// TUN runs the active subscription's proxies and rules. With no active profile it
// falls back to a direct-only bootstrap, which routes nothing through a proxy —
// worth stating plainly so "TUN is on but nothing is proxied" is never a surprise.
const activeProfileName = computed(() => profiles.active?.name ?? null)
</script>

<template>
  <section class="tunlife-panel" aria-label="TUN 状态">
    <header class="tunlife-head">
      <div>
        <h2 class="tunlife-title">TUN 状态</h2>
        <p class="tunlife-subtitle">
          启用后会通过虚拟网卡接管全部流量，包括不遵循系统代理设置的程序。TUN 使用当前配置的节点与分流规则，并可与系统代理同时开启；切换时由同一个内核完成网络接管与恢复。
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
    <p v-else-if="activeProfileName" class="tunlife-note">
      TUN 将使用订阅 <strong>{{ activeProfileName }}</strong> 的节点与规则。
    </p>
    <p v-else class="tunlife-note tunlife-warn">
      当前未激活任何订阅，TUN 将以<strong>直连模式</strong>运行——会接管流量但不走任何代理。如需代理，请先导入并激活一个订阅。
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
  gap: var(--space-5);
}
.tunlife-title { margin: 0 0 4px; font-size: var(--font-size-lg); }
.tunlife-subtitle { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; max-width: 560px; }
.tunlife-subtitle code {
  padding: 1px 4px;
  border-radius: var(--radius-xs);
  background: var(--app-surface-solid);
  font-size: var(--font-size-2xs);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tunlife-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: 5px 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-pill);
  background: var(--app-panel);
  color: var(--app-muted);
  font-size: var(--font-size-xs);
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
.tunlife-note { margin: 10px 0 0; color: var(--app-muted); font-size: var(--font-size-xs); }
.tunlife-warn { color: var(--app-warning); }
.tunlife-actions { margin-top: 14px; display: flex; gap: var(--space-3); }
.tunlife-enable,
.tunlife-disable {
  min-height: 34px;
  padding: 0 18px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
}
.tunlife-enable { background: var(--app-blue); color: var(--app-on-accent); }
.tunlife-disable { background: var(--app-fill); color: inherit; }
.tunlife-enable:disabled,
.tunlife-disable:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
