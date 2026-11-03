import type { LogBundleResult } from '@shared/diagnostics'

/** Timestamp used in exported file names (no characters Windows rejects). */
export function exportStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * Save renderer-built text through the native save dialog. `<a download>`
 * on a blob URL silently does nothing inside the Tauri/WebView2 shell, which
 * is why 日志「导出」 and 导出诊断 used to look dead.
 */
export function saveTextFile(fileName: string, contents: string): Promise<LogBundleResult> {
  return window.desktop.logs.saveText(fileName, contents)
}

/** Both diagnostic entry points export the same privacy-filtered main-process snapshot. */
export async function downloadDiagnosticReport(): Promise<LogBundleResult> {
  const report = await window.desktop.diagnostics.collect()
  return saveTextFile(`murge-diagnostics-${exportStamp()}.json`, JSON.stringify(report, null, 2))
}
