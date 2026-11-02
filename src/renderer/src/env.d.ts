/// <reference types="vite/client" />

import type { DesktopApi } from '@shared/ipc'

declare global {
  interface Window {
    desktop: DesktopApi
    /** Set by the Tauri shell before any page script: 'acrylic' | 'mica' | 'none'. */
    readonly __MURGE_BACKDROP__?: string
  }
}

export {}
