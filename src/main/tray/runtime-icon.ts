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
  // Preserve explicit 1x and 2x representations. Resizing the NativeImage at
  // the call site collapses it to one bitmap and Windows can keep displaying
  // the stale notification-area HICON across DPI/theme/status changes.
  const multiScale = nativeImage.createEmpty()
  multiScale.addRepresentation({ scaleFactor: 1, buffer: image.resize({ width: 16, height: 16 }).toPNG() })
  multiScale.addRepresentation({ scaleFactor: 2, buffer: image.toPNG() })
  return multiScale
}
