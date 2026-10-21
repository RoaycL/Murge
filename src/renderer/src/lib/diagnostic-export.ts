/** Both diagnostic entry points export the same privacy-filtered main-process snapshot. */
export async function downloadDiagnosticReport(): Promise<void> {
  const report = await window.desktop.diagnostics.collect()
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `murge-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
