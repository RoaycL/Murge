<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onMounted, ref } from 'vue'
import { useKernelManagerStore } from '../stores/kernel-manager'

const emit = defineEmits<{ (e: 'close'): void }>()

const kernelManager = useKernelManagerStore()

const search = ref('')
const selected = ref<string | null>(null)

const state = computed(() => kernelManager.state)

const filteredVersions = computed(() => {
  const q = search.value.trim().toLowerCase()
  const versions = state.value.versions
  if (!q) return versions
  return versions.filter((version) => version.toLowerCase().includes(q))
})

const installing = computed(
  () => state.value.installing !== null
)
const selectedIsCurrent = computed(() => selected.value === state.value.effectiveVersion)

function selectVersion(version: string): void {
  selected.value = version
}

async function refresh(): Promise<void> {
  await kernelManager.listVersions()
}

onMounted(() => {
  selected.value = state.value.specificVersion
  if (state.value.specificVersionsSupported) void kernelManager.listVersions()
})

async function confirmInstall(): Promise<void> {
  if (!selected.value || installing.value) return
  const applied = await kernelManager.install(selected.value)
  if (applied) emit('close')
}
</script>

<template>
  <div class="km-backdrop" @click.self="emit('close')">
    <div class="km-modal" role="dialog" aria-modal="true" :aria-label="t('kernelVersion.title')">
      <header class="km-head">
        <h2>{{ t('kernelVersion.title') }}</h2>
        <p v-if="state.specificVersionsSupported">{{ t('kernelVersion.intro') }}</p>
        <p v-else>{{ t('kernelVersion.serviceNote') }}</p>
      </header>

      <div v-if="state.specificVersionsSupported" class="km-toolbar">
        <input
          v-model="search"
          class="km-search"
          type="search"
          :placeholder="t('kernelVersion.searchPlaceholder')"
          :aria-label="t('kernelVersion.searchLabel')"
        />
        <button
          type="button"
          class="km-refresh"
          :disabled="state.versionsLoading"
          @click="refresh"
        >
          {{ state.versionsLoading ? t('kernelVersion.refreshing') : t('common.refresh') }}
        </button>
      </div>

      <p v-if="!state.specificVersionsSupported" class="km-hint">{{ t('kernelVersion.current', [state.effectiveVersion || state.stableVersion || t('kernelVersion.builtinStable')]) }}</p>
      <p v-else-if="state.error" class="inline-error">{{ state.error }}</p>
      <p v-else-if="state.versionsLoading" class="km-hint">{{ t('kernelVersion.loading') }}</p>
      <p v-else-if="!filteredVersions.length" class="km-hint">
        {{ search ? t('kernelVersion.noMatch') : t('kernelVersion.noVersions') }}
      </p>

      <ul v-else-if="state.specificVersionsSupported" class="km-list">
        <li v-for="version in filteredVersions" :key="version">
          <button
            type="button"
            :class="{ selected: selected === version, installing: state.installing === version }"
            :disabled="installing"
            @click="selectVersion(version)"
          >
            <span>{{ version }}</span>
            <em v-if="state.installing === version">{{ t('kernelVersion.installing') }}</em>
            <em v-else-if="state.effectiveVersion === version">{{ t('kernelVersion.currentBadge') }}</em>
          </button>
        </li>
      </ul>

      <footer class="km-actions">
        <button type="button" class="km-cancel" :disabled="installing" @click="emit('close')">
          {{ t('common.cancel') }}
        </button>
        <button
          v-if="state.specificVersionsSupported"
          type="button"
          class="km-install"
          :disabled="!selected || installing || selectedIsCurrent"
          @click="confirmInstall"
        >
          {{ installing ? t('kernelVersion.installing') : t('kernelVersion.install') }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.km-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.km-modal {
  display: flex;
  flex-direction: column;
  width: min(600px, calc(100vw - 40px));
  max-height: min(78vh, 600px);
  background: var(--app-popover); -webkit-backdrop-filter: var(--app-popover-filter); backdrop-filter: var(--app-popover-filter);
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-card);
  box-shadow: var(--app-shadow);
  padding: 18px;
}
.km-head h2 { margin: 0 0 5px; font-size: var(--font-size-lg); }
.km-head p { margin: 0; color: var(--app-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.km-toolbar { display: flex; gap: var(--space-3); margin-top: 14px; }
.km-search {
  flex: 1;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-panel);
  color: inherit;
  font-size: var(--font-size-sm);
}
.km-refresh {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-panel);
  color: inherit;
  font-size: var(--font-size-sm);
}
.km-refresh:disabled { opacity: 0.6; }
.km-hint { margin: 12px 0 0; color: var(--app-muted); font-size: var(--font-size-xs); }
.km-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(124px, 100%), 1fr));
  grid-auto-rows: 34px;
  gap: 6px;
  min-height: 0;
  margin: 12px 0 0;
  padding: 0 2px 2px 0;
  list-style: none;
  overflow-y: auto;
}
.km-list button {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
  text-align: left;
  cursor: pointer;
}
.km-list button:hover:not(:disabled):not(.selected) { background: var(--app-fill-subtle); }
.km-list button.selected { border-color: var(--app-blue); background: rgba(21, 135, 248, 0.08); }
.km-list button:disabled { opacity: 0.6; }
.km-list em { color: var(--app-muted); font-size: var(--font-size-2xs); font-style: normal; }
.km-actions { display: flex; justify-content: flex-end; gap: var(--space-3); margin-top: 16px; }
.km-cancel,
.km-install {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: var(--font-size-sm);
}
.km-cancel { background: var(--app-fill); color: inherit; }
.km-install { background: var(--app-blue); color: var(--app-on-accent); }
.km-cancel:disabled,
.km-install:disabled { opacity: 0.6; }
@media (max-width: 560px) {
  .km-modal { width: calc(100vw - 20px); max-height: calc(100vh - 20px); padding: 14px; }
  .km-toolbar { align-items: stretch; }
  .km-refresh { flex: 0 0 auto; }
  .km-list { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
}
</style>
