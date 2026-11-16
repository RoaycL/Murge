<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ACCENT_PRESETS, FONT_SUGGESTIONS, MAX_CUSTOM_CSS_LENGTH, UI_STYLE_VARIABLES, normalizeAccent, normalizeFontFamily, type UiFontScale } from '@shared/ui-style'
import { SAFE_MODE_SHORTCUT, useUiStyleStore } from '../stores/ui-style'
import { useUnsavedChanges } from '../composables/use-unsaved-changes'
import { useToast } from '../composables/use-toast'

const store = useUiStyleStore()
const toast = useToast()
const { saved, suspended, trialCss } = storeToRefs(store)

const fontScales: Array<{ value: UiFontScale; label: string }> = [
  { value: 'small', label: '小' },
  { value: 'default', label: '标准' },
  { value: 'large', label: '大' },
  { value: 'larger', label: '特大' }
]

const customAccent = computed(() => saved.value.accent && !ACCENT_PRESETS.some((preset) => preset.value === saved.value.accent) ? saved.value.accent : '')
function pickCustomAccent(event: Event): void {
  const value = normalizeAccent((event.target as HTMLInputElement).value)
  if (value) void store.setAccent(value)
}

const fontDraft = ref(saved.value.fontFamily)
watch(() => saved.value.fontFamily, (value) => { fontDraft.value = value })
const fontError = computed(() => fontDraft.value.trim() && !normalizeFontFamily(fontDraft.value) ? '字体名里不能有 ; { } < > \\ 或 url( ，引号要成对。' : '')
function commitFont(): void {
  if (fontError.value) return
  const value = normalizeFontFamily(fontDraft.value)
  if (value !== saved.value.fontFamily) void store.setFontFamily(value)
}

const cssDraft = ref(saved.value.customCss)
watch(() => saved.value.customCss, (value) => { cssDraft.value = value })
const cssDirty = computed(() => cssDraft.value !== saved.value.customCss)
useUnsavedChanges('ui-style-css', '自定义 CSS', cssDirty)
const cssEnabled = computed(() => trialCss.value !== null || (saved.value.customCssEnabled && !suspended.value))

function onEditorKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey) return
  event.preventDefault()
  const target = event.target as HTMLTextAreaElement
  const { selectionStart, selectionEnd } = target
  cssDraft.value = `${cssDraft.value.slice(0, selectionStart)}  ${cssDraft.value.slice(selectionEnd)}`
  requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = selectionStart + 2 })
}

const fileInput = ref<HTMLInputElement | null>(null)
async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > MAX_CUSTOM_CSS_LENGTH * 4) { toast.error('文件太大', '自定义 CSS 最多 64 KB。'); return }
  const text = await file.text()
  if (text.length > MAX_CUSTOM_CSS_LENGTH) { toast.error('文件太大', '自定义 CSS 最多 64 KB。'); return }
  cssDraft.value = text
}

function toggleCss(): void {
  if (suspended.value) { store.toggleSuspended(); return }
  // 关掉时丢弃没应用的草稿；重新打开时编辑框显示之前保存的 CSS。
  if (cssEnabled.value) cssDraft.value = saved.value.customCss
  store.setCustomCssEnabled(!cssEnabled.value)
}

const example = `/* 例：换一种背景渐变，卡片圆角更大 */
:root {
  --app-background-start: #f3efe6;
  --radius-card: 16px;
}`
</script>

<template>
  <section class="ui-style-section">
    <div class="section-heading">
      <h2>样式</h2>
      <button type="button" class="secondary-button" :disabled="store.isDefault" @click="store.resetAll()">恢复默认</button>
    </div>
    <div class="surface-card preference-list ui-style-list">
      <div class="ui-style-row">
        <span><strong>强调色</strong><small>按钮、开关和选中项的颜色。</small></span>
        <div class="accent-swatches" role="radiogroup" aria-label="强调色">
          <button v-for="preset in ACCENT_PRESETS" :key="preset.value || 'default'" type="button" role="radio" class="accent-swatch" :class="{ selected: saved.accent === preset.value }" :aria-checked="saved.accent === preset.value" :aria-label="preset.label" :title="preset.label" :style="{ '--swatch': preset.value || '#1587f8' }" @click="store.setAccent(preset.value)" />
          <div class="accent-swatch accent-custom" :class="{ selected: Boolean(customAccent) }" title="自定义颜色" :style="customAccent ? { '--swatch': customAccent } : undefined">
            <input type="color" aria-label="自定义强调色" :value="customAccent || saved.accent || '#1587f8'" @change="pickCustomAccent" />
          </div>
        </div>
      </div>
      <div class="ui-style-row">
        <span><strong>字体</strong><small>填写已安装的字体名，多个用逗号分隔；留空使用系统默认字体。</small></span>
        <div class="font-field">
          <input v-model="fontDraft" type="text" list="ui-style-fonts" spellcheck="false" placeholder="系统默认" aria-label="字体" :aria-invalid="Boolean(fontError)" @change="commitFont" @keydown.enter="commitFont" />
          <datalist id="ui-style-fonts"><option v-for="font in FONT_SUGGESTIONS" :key="font" :value="font" /></datalist>
        </div>
      </div>
      <p v-if="fontError" class="inline-error font-error">{{ fontError }}</p>
      <div class="ui-style-row">
        <span><strong>字号</strong><small>按比例调整界面上所有文字的大小。</small></span>
        <div class="segmented font-scale" role="radiogroup" aria-label="字号">
          <button v-for="scale in fontScales" :key="scale.value" type="button" role="radio" :aria-checked="saved.fontScale === scale.value" :class="{ selected: saved.fontScale === scale.value }" @click="store.setFontScale(scale.value)">{{ scale.label }}</button>
        </div>
      </div>
    </div>
  </section>

  <section class="ui-style-section custom-css-section">
    <h2>自定义 CSS</h2>
    <div class="surface-card preference-list">
      <label>
        <span>
          <strong>启用自定义 CSS</strong>
          <small v-if="suspended">已临时停用（{{ SAFE_MODE_SHORTCUT }}），重启或再按一次恢复。</small>
          <small v-else>界面出问题时按 {{ SAFE_MODE_SHORTCUT }} 可立即停用。</small>
        </span>
        <button type="button" class="switch" :class="{ on: cssEnabled }" :aria-checked="cssEnabled" aria-label="启用自定义 CSS" @click="toggleCss" />
      </label>
    </div>
    <template v-if="cssEnabled">
    <div class="surface-card css-editor-card">
      <textarea v-model="cssDraft" class="css-editor" spellcheck="false" autocapitalize="off" autocomplete="off" :maxlength="MAX_CUSTOM_CSS_LENGTH" :placeholder="example" aria-label="自定义 CSS" @keydown="onEditorKeydown" />
      <div class="css-editor-actions">
        <small>{{ cssDraft.length.toLocaleString() }} / {{ MAX_CUSTOM_CSS_LENGTH.toLocaleString() }}</small>
        <input ref="fileInput" type="file" accept=".css,text/css" hidden @change="importFile" />
        <button type="button" class="secondary-button" @click="fileInput?.click()">导入文件</button>
        <button type="button" class="secondary-button" :disabled="!cssDirty" @click="cssDraft = saved.customCss">撤销修改</button>
        <button type="button" class="primary-button" :disabled="!cssDraft.trim() && !saved.customCss" @click="store.tryCustomCss(cssDraft)">应用</button>
      </div>
    </div>
    <p class="section-hint">应用后会先试用 15 秒，点「保留」才会保存；没确认就自动还原。为了安全，CSS 不能加载网络上的字体或图片，只能用本机已安装的字体。</p>
    <details class="css-variables">
      <summary>可覆盖的变量</summary>
      <dl>
        <template v-for="variable in UI_STYLE_VARIABLES" :key="variable.name"><dt><code>{{ variable.name }}</code></dt><dd>{{ variable.detail }}</dd></template>
      </dl>
      <p>页面根元素带有 <code>data-theme="light|dark"</code>、<code>data-frosted</code>、<code>data-contrast</code> 属性，可以按主题分别写规则，例如 <code>:root[data-theme="dark"] { … }</code>。</p>
    </details>
    </template>
  </section>
</template>

<style scoped>
.ui-style-section { margin-top: 27px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 11px; }
.section-heading h2 { margin: 0; }
.ui-style-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-7); min-height: 65px; padding: 10px 14px; border-bottom: 1px solid var(--app-divider); }
.ui-style-row:last-child { border-bottom: 0; }
.ui-style-row > span { min-width: 0; }
.accent-swatches { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.accent-swatch { position: relative; flex: 0 0 auto; box-sizing: border-box; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: var(--swatch); cursor: pointer; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12); }
.accent-swatch.selected { box-shadow: 0 0 0 2px var(--app-surface-solid), 0 0 0 4px var(--swatch); }
.accent-custom { background: conic-gradient(#e0443e, #e8b21c, #3fb34f, #19bdd6, #1587f8, #8e5af7, #e5508f, #e0443e); }
.accent-custom.selected { background: var(--swatch); }
.accent-custom input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.font-field input { width: 260px; height: 28px; padding: 0 9px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: var(--app-fill-subtle); color: inherit; }
.font-field input[aria-invalid="true"] { border-color: var(--app-danger); }
.font-error { margin: -4px 14px 8px; }
.font-scale button { width: 48px; }
.custom-css-section .preference-list { margin-bottom: var(--space-5); }
.css-editor-card { padding: 10px; border-radius: var(--radius-md); }
.css-editor { display: block; box-sizing: border-box; width: 100%; min-height: 220px; padding: 10px 12px; border: 1px solid var(--app-divider); border-radius: var(--radius-control); background: var(--app-panel); color: inherit; font: 12.5px/1.55 "Cascadia Code", Consolas, ui-monospace, monospace; resize: vertical; tab-size: 2; white-space: pre; outline: none; }
.css-editor:focus { border-color: color-mix(in srgb, var(--app-blue) 55%, transparent); }
.css-editor-actions button { font-size: var(--font-size-sm); }
.css-editor-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); margin-top: 10px; }
.css-editor-actions small { margin-right: auto; color: var(--app-muted); font-size: var(--font-size-2xs); font-variant-numeric: tabular-nums; }
.primary-button:disabled, .secondary-button:disabled { opacity: 0.5; cursor: default; }
.section-hint { margin: 10px 2px 0; color: var(--app-muted); font-size: var(--font-size-2xs); line-height: 1.5; }
.css-variables { margin-top: 12px; color: var(--app-muted); font-size: var(--font-size-xs); }
.css-variables summary { cursor: pointer; color: var(--app-text); }
.css-variables dl { display: grid; grid-template-columns: max-content 1fr; gap: 5px 16px; margin: 10px 0 0; }
.css-variables dt, .css-variables dd { margin: 0; }
.css-variables code { font-family: "Cascadia Code", Consolas, ui-monospace, monospace; font-size: var(--font-size-xs); color: var(--app-text); }
.css-variables p { margin: 10px 0 0; line-height: 1.5; }
</style>
