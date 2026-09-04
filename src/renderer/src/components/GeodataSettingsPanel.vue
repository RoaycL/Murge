<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useGeodataSettingsStore } from '../stores/geodata-settings'
import type { GeodataSettings, GeoipMode } from '@shared/geodata'
import { EMPTY_GEODATA_SETTINGS } from '@shared/geodata'
import AppSelect from './AppSelect.vue'
import AppIcon from './AppIcon.vue'

const store = useGeodataSettingsStore()

const form = reactive<GeodataSettings>({ ...EMPTY_GEODATA_SETTINGS })

const previewYaml = ref('')
const previewOpen = ref(false)

const GEOIP_OPTIONS: Array<{ value: GeoipMode; label: string }> = [
  { value: 'standard', label: 'standard' },
  { value: 'memconservative', label: 'memconservative' }
]

const INTERVAL_MIN = 1
const INTERVAL_MAX = 168

function syncFromConfig(value: GeodataSettings): void {
  form.enabled = value.enabled
  form.geodataMode = value.geodataMode
  form.geoipMode = value.geoipMode
  form.autoUpdate = value.autoUpdate
  form.updateIntervalHours = value.updateIntervalHours
  form.geoxUrl = value.geoxUrl
}

async function save(): Promise<void> {
  const ok = await store.save({ ...form })
  if (ok) syncFromConfig(store.settings)
}

async function preview(): Promise<void> {
  previewYaml.value = await store.preview({ ...form })
  previewOpen.value = true
}

function resetFromStore(): void {
  syncFromConfig(store.settings)
}

watch(
  () => store.settings,
  (value) => syncFromConfig(value),
  { deep: true }
)

onMounted(async () => {
  await store.refresh()
  syncFromConfig(store.settings)
})
</script>

<template>
  <section class="gd-panel" aria-label="mihomo geodata 资源设置">
    <header class="gd-head">
      <div>
        <h2 class="gd-title">mihomo geodata 资源</h2>
        <p class="gd-subtitle">
          控制 mihomo 的 GeoIP / GeoSite 二进制数据匹配与自动更新（geodata-mode、geoip-mode、geo-auto-update、geo-update-interval、geo-x-url），不修改订阅源文件；启用时这些值会在运行时配置中生效并覆盖配置文件的同名项。
        </p>
      </div>
      <button type="button" class="gd-reset" @click="resetFromStore">重置</button>
    </header>

    <p v-if="store.lastError" class="inline-error" role="alert">{{ store.lastError }}</p>

    <p v-if="!form.enabled" class="gd-hint">当前未启用，运行时会保留配置文件自身的 geodata 设置（不会覆盖）。</p>

    <div class="gd-body">
      <fieldset class="gd-group">
        <legend>启用</legend>
        <label class="gd-switch inline">
          <input v-model="form.enabled" type="checkbox" aria-label="启用 geodata 覆盖" />
          <span class="gd-switch-track" />
          <span class="gd-label">启用后覆盖配置文件的同名 geodata 参数</span>
        </label>
      </fieldset>

      <fieldset class="gd-group">
        <legend>匹配模式</legend>
        <div class="gd-grid">
          <label class="gd-switch small">
            <input v-model="form.geodataMode" type="checkbox" aria-label="geodata-mode" />
            <span class="gd-switch-track" />
            <span class="gd-label"> geodata-mode（二进制数据匹配）</span>
          </label>
          <label class="gd-field">
            <span class="gd-label">geoip-mode</span>
            <AppSelect v-model="form.geoipMode" :options="GEOIP_OPTIONS" label="GeoIP 模式" />
          </label>
        </div>
      </fieldset>

      <fieldset class="gd-group">
        <legend>自动更新</legend>
        <div class="gd-grid">
          <label class="gd-switch small">
            <input v-model="form.autoUpdate" type="checkbox" aria-label="geo-auto-update" />
            <span class="gd-switch-track" />
            <span class="gd-label"> geo-auto-update（mihomo 自动更新 geodata）</span>
          </label>
          <label class="gd-field">
            <span class="gd-label">geo-update-interval（小时）</span>
            <input
              v-model.number="form.updateIntervalHours"
              class="gd-input"
              type="number"
              :min="INTERVAL_MIN"
              :max="INTERVAL_MAX"
              step="1"
              aria-label="geo-update-interval"
            />
          </label>
        </div>
      </fieldset>

      <fieldset class="gd-group">
        <legend>数据源 URL（可选）</legend>
        <label class="gd-field">
          <span class="gd-label">geo-x-url</span>
          <input
            v-model="form.geoxUrl"
            class="gd-input"
            type="url"
            placeholder="https://…（留空则保留配置文件的源）"
            aria-label="geo-x-url"
          />
        </label>
        <p class="gd-note">留空时不会覆盖配置文件已有的 geodata 源；仅当填写了绝对 http(s) URL 才生效。</p>
      </fieldset>

      <div class="gd-actions">
        <button type="button" class="gd-preview" @click="preview">预览配置</button>
        <button type="button" class="gd-save" :disabled="store.busy" @click="save">保存</button>
      </div>

      <div v-if="previewOpen" class="gd-preview">
        <div class="gd-preview-head">
          <span>运行时生效的 mihomo geodata 键</span>
          <button type="button" class="gd-icon" aria-label="关闭预览" @click="previewOpen = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <pre class="gd-preview-body">{{ previewYaml || '（空）' }}</pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.gd-panel {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--app-divider);
}
.gd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.gd-title { margin: 0 0 4px; font-size: 15px; }
.gd-subtitle { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; max-width: 560px; }
.gd-reset {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-panel);
  color: inherit;
  font-size: 12px;
  white-space: nowrap;
}
.gd-body { margin-top: 14px; display: grid; gap: 14px; }
.gd-hint { margin: 0; color: var(--app-muted); font-size: 11px; }
.gd-group {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.gd-group legend { padding: 0 6px; color: var(--app-muted); font-size: 11px; }
.gd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.gd-field { display: grid; gap: 5px; }
.gd-label { color: var(--app-muted); font-size: 11px; }
.gd-note { margin: 6px 0 0; color: var(--app-muted); font-size: 10px; }
.gd-select,
.gd-input {
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  color: inherit;
  font-size: 12px;
}
.gd-actions { display: flex; justify-content: flex-end; gap: 8px; }
.gd-preview,
.gd-save {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
}
.gd-preview { background: rgba(127, 127, 127, 0.14); color: inherit; }
.gd-save { background: var(--app-blue); color: white; }
.gd-save:disabled { opacity: 0.6; }
.gd-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.gd-switch.inline { min-height: 34px; }
.gd-switch.small { min-height: 34px; }
.gd-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.gd-switch-track {
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.28);
  position: relative;
  transition: background 0.15s ease;
  flex: none;
}
.gd-switch-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  transition: transform 0.15s ease;
}
.gd-switch input:checked + .gd-switch-track { background: var(--app-blue); }
.gd-switch input:checked + .gd-switch-track::after { transform: translateX(14px); }
.gd-preview-block {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-divider);
  border-radius: 9px;
  background: var(--app-panel);
}
.gd-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--app-muted);
  font-size: 11px;
}
.gd-icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}
.gd-preview-body {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--app-divider);
  border-radius: 7px;
  background: var(--app-surface-solid);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
}
</style>
