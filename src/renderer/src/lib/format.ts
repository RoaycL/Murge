/** Compact, stable human-readable byte/rate formatting used across the UI. */

export interface RateText {
  value: string
  unit: string
}

export interface ByteText {
  value: string
  unit: string
}

export function formatBytes(bytes: number): string {
  const { value, unit } = formatBytesParts(bytes)
  return `${value} ${unit}`
}

export function formatBytesParts(bytes: number): ByteText {
  const value = Math.max(0, bytes)
  if (value < 1024) return { value: `${Math.round(value)}`, unit: 'B' }
  if (value < 1024 * 1024) return { value: `${Math.round(value / 1024)}`, unit: 'KB' }
  if (value < 1024 * 1024 * 1024) return { value: `${(value / (1024 * 1024)).toFixed(1)}`, unit: 'MB' }
  return { value: `${(value / (1024 * 1024 * 1024)).toFixed(2)}`, unit: 'GB' }
}

export function formatRate(bytesPerSecond: number): RateText {
  const value = Math.max(0, bytesPerSecond)
  if (value < 1024) return { value: `${Math.round(value)}`, unit: 'B/s' }
  if (value < 1024 * 1024) return { value: `${Math.round(value / 1024)}`, unit: 'KB/s' }
  if (value < 1024 * 1024 * 1024) return { value: `${(value / (1024 * 1024)).toFixed(1)}`, unit: 'MB/s' }
  return { value: `${(value / (1024 * 1024 * 1024)).toFixed(1)}`, unit: 'GB/s' }
}
