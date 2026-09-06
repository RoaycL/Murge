import { nativeImage, type NativeImage } from 'electron'
import { RUNTIME_ACCENT_HEX, type RuntimeAccent } from '@shared/runtime-accent'

/** Code-native version of the approved rounded M / subtle cat-ear mark. */
export function createRuntimeIcon(
  accent: RuntimeAccent,
  dark: boolean,
  size = 64
): NativeImage {
  const background = dark ? '#000000' : '#ffffff'
  const foreground = dark ? '#ffffff' : '#111216'
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="${background}"/>
      <path d="M15 48V18c0-4 4-6 7-3l10 10 10-10c3-3 7-1 7 3v30" fill="none" stroke="${foreground}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="m22 35 7 7c2 2 4 2 6 0l8-7" fill="none" stroke="${background}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="m29.5 47 10-9" fill="none" stroke="${RUNTIME_ACCENT_HEX[accent]}" stroke-width="7" stroke-linecap="round"/>
    </svg>`
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
}
