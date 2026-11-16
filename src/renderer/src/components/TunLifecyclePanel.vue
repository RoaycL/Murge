<script setup lang="ts">
import { t } from '@shared/i18n'
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
    ? t('tunStatus.activeUnverified')
    : TUN_UI_COPY[phase.value]
))
const detail = computed(() => tunLifecycleDetail(tun.status))

// TUN runs the active subscription's proxies and rules. With no active profile it
// falls back to a direct-only bootstrap, which routes nothing through a proxy —
// worth stating plainly so "TUN is on but nothing is proxied" is never a surprise.
const activeProfileName = computed(() => profiles.active?.name ?? null)
</script>

<template>
  <section class="tunlife-panel" :aria-label="t('tunStatus.title')">
    <header class="tunlife-head">
      <div>
        <h2 class="tunlife-title">{{ t('tunStatus.title') }}</h2>
        <p class="tunlife-subtitle">
          {{ t('tunStatus.intro') }}
        </p>
      </div>
      <div class="tunlife-status" :class="{ active: gating.active }">
        <i class="tunlife-dot" />
        <span>{{ phaseLabel }}</span>
      </div>
    </header>

    <p v-if="tun.actionError" class="inline-error" role="alert">{{ tun.actionError }}</p>
    <p v-if="gating.showConflict" class="inline-error" role="alert">{{ t('tunStatus.externalChange', [detail]) }}</p>
    <p v-if="gating.showError" class="inline-error" role="alert">{{ detail }}</p>
    <p v-if="gating.showUnsupported" class="tunlife-note">
      {{ t('tunStatus.unsupported') }}
    </p>
    <p v-else-if="activeProfileName" class="tunlife-note">
      {{ t('tunStatus.usesProfileA') }} <strong>{{ activeProfileName }}</strong>{{ t('tunStatus.usesProfileB') }}
    </p>
    <p v-else class="tunlife-note tunlife-warn">
      {{ t('tunStatus.noProfileA') }}<strong>{{ t('tunStatus.directMode') }}</strong>{{ t('tunStatus.noProfileB') }}
    </p>

    <div class="tunlife-actions">
      <button type="button" class="tunlife-enable" :disabled="!gating.canEnable" :aria-label="gating.enableLabel" @click="tun.enable()">
        {{ gating.busyPhase ? t('common.processing') : gating.enableLabel }}
      </button>
      <button type="button" class="tunlife-disable" :disabled="!gating.canDisable" :aria-label="t('tunStatus.disableTun')" @click="tun.disable()">
        {{ phase === 'restoring' ? t('tunStatus.restoring') : t('common.turnOff') }}
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
