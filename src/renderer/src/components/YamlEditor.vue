<script setup lang="ts">
import { t } from '@shared/i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { analyzeYaml, highlightYamlLine, type YamlAnalysis, type YamlSection } from '@shared/yaml-outline'

/**
 * Config YAML editor: line numbers, syntax colours, an outline of the
 * top-level sections and parse errors pinned to their lines. The text is a
 * plain <textarea> laid over the highlighted copy, so editing, undo, IME and
 * copy behave exactly like before.
 */
const props = defineProps<{ modelValue: string; readonly?: boolean; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const LINE_HEIGHT = 19
const scroller = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
const analysis = ref<YamlAnalysis>(analyzeYaml(props.modelValue))
const highlighted = ref('')
const activeLine = ref(1)
const lineCache = new Map<string, string>()
let analyzeTimer: ReturnType<typeof setTimeout> | undefined
let highlightTimer: ReturnType<typeof setTimeout> | undefined

function renderHighlight(text: string): void {
  if (lineCache.size > 20000) lineCache.clear()
  const out: string[] = []
  for (const line of text.split('\n')) {
    let html = lineCache.get(line)
    if (html === undefined) { html = highlightYamlLine(line); lineCache.set(line, html) }
    out.push(html)
  }
  // A trailing space keeps the last (possibly empty) line one row tall.
  highlighted.value = out.join('\n') + ' '
}

watch(() => props.modelValue, (text, previous) => {
  const big = text.length > 200_000
  clearTimeout(highlightTimer)
  if (big && previous !== undefined) highlightTimer = setTimeout(() => renderHighlight(props.modelValue), 60)
  else renderHighlight(text)
  clearTimeout(analyzeTimer)
  analyzeTimer = setTimeout(() => { analysis.value = analyzeYaml(props.modelValue) }, big ? 400 : 160)
}, { immediate: true })

onBeforeUnmount(() => { clearTimeout(analyzeTimer); clearTimeout(highlightTimer) })

const lineCount = computed(() => props.modelValue.split('\n').length)
const errors = computed(() => analysis.value.problems.filter((p) => p.severity === 'error'))
const errorLines = computed(() => new Set(errors.value.filter((p) => p.line > 0).map((p) => p.line)))
const gutter = computed(() => {
  const rows: string[] = []
  for (let i = 1; i <= lineCount.value; i += 1) rows.push(String(i))
  return rows.join('\n')
})
const rowTop = (line: number) => `${(line - 1) * LINE_HEIGHT + 8}px`
const gutterWidth = computed(() => `${Math.max(2, String(lineCount.value).length) + 2}ch`)

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
  trackCaret()
}

function trackCaret(): void {
  const el = input.value
  if (!el) return
  const before = el.value.slice(0, el.selectionStart)
  let line = 1
  for (let i = before.indexOf('\n'); i >= 0; i = before.indexOf('\n', i + 1)) line += 1
  activeLine.value = line
}

function goToLine(line: number): void {
  const el = input.value
  const box = scroller.value
  if (!el || !box || line < 1) return
  box.scrollTop = Math.max(0, (line - 1) * LINE_HEIGHT - 24)
  box.scrollLeft = 0
  let offset = 0
  for (let i = 1; i < line; i += 1) {
    const next = el.value.indexOf('\n', offset)
    if (next < 0) break
    offset = next + 1
  }
  el.focus({ preventScroll: true })
  el.setSelectionRange(offset, offset)
  activeLine.value = line
}

function sectionDetail(section: YamlSection): string {
  if (section.count === undefined) return section.value ?? ''
  const n = section.count
  if (section.kind === 'list') return n === 1 ? t('yamlEditor.item', [n]) : t('yamlEditor.items', [n])
  return n === 1 ? t('yamlEditor.key', [n]) : t('yamlEditor.keys', [n])
}

defineExpose({ goToLine })
</script>

<template>
  <div class="yaml-editor" :class="{ readonly }">
    <aside class="ye-outline" :aria-label="t('yamlEditor.outline')">
      <div class="ye-status" :class="errors.length ? 'bad' : 'ok'" role="status" aria-live="polite">
        <strong>{{ errors.length ? t('yamlEditor.errors', [errors.length]) : t('yamlEditor.valid') }}</strong>
        <span>{{ t('yamlEditor.lines', [lineCount]) }}</span>
      </div>
      <ul v-if="errors.length" class="ye-problems">
        <li v-for="(problem, index) in errors.slice(0, 20)" :key="'e' + index">
          <button type="button" :disabled="!problem.line" @click="goToLine(problem.line)">
            <b>{{ problem.line ? t('yamlEditor.lineN', [problem.line]) : '—' }}</b>
            <span>{{ problem.message }}</span>
          </button>
        </li>
      </ul>
      <h3>{{ t('yamlEditor.sections') }}</h3>
      <ul class="ye-sections">
        <li v-for="section in analysis.sections" :key="section.key + section.line">
          <button type="button" :class="{ current: section.line <= activeLine && !analysis.sections.some(s => s.line > section.line && s.line <= activeLine) }" :title="t('yamlEditor.lineN', [section.line])" @click="goToLine(section.line)">
            <span>{{ section.key }}</span>
            <small>{{ sectionDetail(section) }}</small>
          </button>
        </li>
        <li v-if="!analysis.sections.length" class="ye-empty">{{ t('yamlEditor.noSections') }}</li>
      </ul>
    </aside>
    <div ref="scroller" class="ye-scroll">
      <div class="ye-inner">
        <div class="ye-gutter" :style="{ width: gutterWidth }" aria-hidden="true">{{ gutter }}<span v-if="!errorLines.has(activeLine)" class="ye-mark active" :style="{ top: rowTop(activeLine) }">{{ activeLine }}</span><span v-for="line in errorLines" :key="line" class="ye-mark err" :style="{ top: rowTop(line) }">{{ line }}</span></div>
        <div class="ye-code">
          <div class="ye-lines" aria-hidden="true"><div v-for="line in errorLines" :key="line" class="ye-err-band" :style="{ top: rowTop(line) }" /></div>
          <pre class="ye-highlight" aria-hidden="true" v-html="highlighted" />
          <textarea ref="input" class="ye-input" :value="modelValue" :readonly="readonly" :aria-label="label" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" @input="onInput" @click="trackCaret" @keyup="trackCaret" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.yaml-editor {
  --ye-line: 19px;
  --yt-key: var(--app-accent);
  --yt-str: color-mix(in srgb, var(--app-green) 72%, var(--app-text));
  --yt-num: var(--app-purple);
  --yt-bool: var(--app-pink);
  --yt-anchor: var(--app-cyan);
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  height: 100%;
  border: 1px solid var(--app-divider);
  border-radius: var(--radius-control);
  background: var(--app-surface-solid);
  overflow: hidden;
}
.ye-outline {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  padding: 10px 8px;
  border-right: 1px solid var(--app-divider);
  font-size: var(--font-size-xs);
}
.ye-status { display: grid; gap: 2px; padding: 6px 8px 10px; }
.ye-status strong { font-weight: var(--font-weight-semibold); }
.ye-status.ok strong { color: var(--app-green); }
.ye-status.bad strong { color: var(--app-danger); }
.ye-status span { color: var(--app-muted); font-size: var(--font-size-2xs); }
.ye-outline h3 { margin: 8px 8px 4px; color: var(--app-muted); font-size: var(--font-size-2xs); font-weight: var(--font-weight-medium); }
.ye-outline ul { margin: 0; padding: 0; list-style: none; }
.ye-outline button {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.ye-outline button:hover:not(:disabled) { background: var(--app-sidebar-selected); }
.ye-sections button.current { color: var(--app-accent); }
.ye-sections span { min-width: 0; overflow: hidden; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.ye-sections small { flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--app-muted); font-size: var(--font-size-2xs); font-variant-numeric: tabular-nums; }
.ye-problems button { flex-direction: column; gap: 2px; color: var(--app-danger); }
.ye-problems b { font-weight: var(--font-weight-semibold); }
.ye-problems span { color: var(--app-text); overflow-wrap: anywhere; }
.ye-empty { padding: 5px 8px; color: var(--app-muted); }
.ye-scroll { position: relative; min-width: 0; min-height: 0; overflow: auto; }
.ye-inner { display: flex; min-width: max-content; min-height: 100%; }
.ye-gutter {
  position: sticky;
  z-index: 2;
  left: 0;
  flex: none;
  box-sizing: border-box;
  padding: 8px 8px 8px 0;
  border-right: 1px solid var(--app-divider);
  background: var(--app-surface-solid);
  color: var(--app-faint);
  font: 12px/var(--ye-line) ui-monospace, "Cascadia Code", Consolas, monospace;
  text-align: right;
  user-select: none;
}
.ye-gutter { white-space: pre; }
.ye-mark { position: absolute; right: 8px; left: 0; background: var(--app-surface-solid); }
.ye-mark.active { color: var(--app-text); }
.ye-mark.err { color: var(--app-danger); font-weight: var(--font-weight-semibold); }
.ye-code { position: relative; flex: 1; min-width: 0; }
.ye-highlight, .ye-input {
  box-sizing: border-box;
  margin: 0;
  padding: 8px 24px 8px 10px;
  border: 0;
  font: 12px/var(--ye-line) ui-monospace, "Cascadia Code", Consolas, monospace;
  letter-spacing: 0;
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
}
.ye-highlight { position: relative; min-height: 100%; color: var(--app-text); pointer-events: none; }
.ye-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  resize: none;
  outline: none;
  background: transparent;
  color: transparent;
  caret-color: var(--app-text);
  user-select: text;
}
.ye-input::selection { background: color-mix(in srgb, var(--app-accent) 28%, transparent); color: transparent; }
.ye-lines { position: absolute; inset: 0; pointer-events: none; }
.ye-err-band { position: absolute; left: 0; right: 0; height: var(--ye-line); background: color-mix(in srgb, var(--app-danger) 13%, transparent); }
.ye-highlight :deep(.yt-key) { color: var(--yt-key); }
.ye-highlight :deep(.yt-str) { color: var(--yt-str); }
.ye-highlight :deep(.yt-num) { color: var(--yt-num); }
.ye-highlight :deep(.yt-bool) { color: var(--yt-bool); }
.ye-highlight :deep(.yt-anchor), .ye-highlight :deep(.yt-tag) { color: var(--yt-anchor); }
.ye-highlight :deep(.yt-punct) { color: var(--app-muted); }
.ye-highlight :deep(.yt-comment) { color: var(--app-muted); }
@media (max-width: 760px) {
  .yaml-editor { grid-template-columns: minmax(0, 1fr); }
  .ye-outline { display: none; }
}
</style>
