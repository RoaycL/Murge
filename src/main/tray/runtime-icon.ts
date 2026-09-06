import { join } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'
import type { RuntimeAccent } from '@shared/runtime-accent'

/** Load the pre-rasterized 32px tray asset; runtime SVG downscaling is unreliable on Windows. */
export function createRuntimeIcon(
  iconRoot: string,
  accent: RuntimeAccent,
  dark: boolean
): NativeImage {
  const path = join(iconRoot, `tray-${dark ? 'dark' : 'light'}-${accent}.png`)
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) throw new Error(`Tray icon could not be loaded: ${path}`)
  return image
}
