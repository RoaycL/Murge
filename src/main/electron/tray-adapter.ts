import { app, clipboard, nativeTheme, shell } from 'electron'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { brand } from '@shared/brand'
import { resolveRuntimeAccent } from '@shared/runtime-accent'
import { TrayController, type TrayView, type TrayControllerOptions } from '../tray/tray-controller'
import { createElectronTray } from '../tray/electron-tray'
import type { SystemProxyService } from '../system-proxy/service'
import type { ApplicationState } from './runtime-state'

/**
 * Tray adapter: creates the Electron TrayView and the TrayController with the
 * exact dependency set the former monolithic `src/main/index.ts` wired. The
 * controller itself is untouched; only its construction moved here so the
 * Tauri side can later supply its own TrayView behind the same interface.
 */
export interface TrayAdapterDeps {
  state: ApplicationState
  /** Queued kernel gateway (the ONE mode-transition queue entry point). */
  kernel: TrayControllerOptions['kernel']
  /** Selection-recording mihomo gateway the renderer also talks to. */
  mihomo: TrayControllerOptions['mihomo']
  /** Profile gateway (auto-reload wrapper). */
  profiles: TrayControllerOptions['profiles']
  systemProxy: SystemProxyService
  tun: TrayControllerOptions['tun']
  internetLatency: TrayControllerOptions['internetLatency']
  /** Order from the exact enhanced document materialized for mihomo. */
  resolveGroupOrder: () => Promise<string[]>
  resolveGroupIcon: (cacheKey: string, url: string | undefined, refresh: boolean) => Promise<string | null>
  /** Controller-patch reload used by the tray's 重新载入当前配置 entry. */
  reloadConfig: () => Promise<void>
  restartKernel: () => Promise<void>
  onCheckUpdate: () => void
  /** Reveal/focus the main window (tray show entry). */
  showWindow: () => void
  quit: () => void
  /** Live TUN phase reader for the tray accent (active/starting/restoring…). */
  tunStatusPhase: () => import('@shared/tun').TunStatus['phase']
  /** Persistent kernel workspace (kernel directory tray shortcut). */
  kernelRoot: string
  /** Log directory (log directory tray shortcut). */
  logDirectory: string
  onError: (error: unknown) => void
}

export interface TrayAdapter {
  /** Initialize the native tray; resolved when the tray is live. */
  initialize(): Promise<void>
  /** True once the native tray exists (hidden-start smoke probe). */
  isReady(): boolean
  /** Dispose the controller (idempotent). */
  dispose(): void
  /** Recompute tray accent from proxy/TUN phases + native theme. */
  updateRuntimeAppearance(): void
  /** Attach theme + status listeners; returns the combined unsubscribe. */
  attachAppearanceListeners(
    unsubscribeProxy: () => void,
    unsubscribeTun: () => void
  ): () => void
}

export function createTrayAdapter(
  deps: TrayAdapterDeps,
  options: { isDev: boolean }
): TrayAdapter {
  const { state } = deps

  const trayIconRoot = options.isDev
    ? join(app.getAppPath(), 'resources', 'tray')
    : join(process.resourcesPath, 'tray')
  const trayView: TrayView = createElectronTray(trayIconRoot, nativeTheme.shouldUseDarkColors)
  const openTrayDirectory = async (directory: 'application' | 'working' | 'kernel' | 'logs'): Promise<void> => {
    const target = directory === 'application'
      ? dirname(app.getPath('exe'))
      : directory === 'working'
        ? app.getPath('userData')
        : directory === 'kernel'
          ? deps.kernelRoot
          : deps.logDirectory
    if (directory !== 'application') await mkdir(target, { recursive: true })
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  }

  const trayController = new TrayController({
    productName: brand.productName,
    // Tray start/stop goes through the ONE mode-transition queue like every
    // other entry point (queuedKernel.stop() keeps the unified gateway's
    // restore-proxy-before-stop ordering when TUN is serving).
    kernel: deps.kernel,
    view: trayView,
    showWindow: deps.showWindow,
    quit: deps.quit,
    systemProxy: deps.systemProxy,
    tun: deps.tun,
    mihomo: deps.mihomo,
    profiles: deps.profiles,
    internetLatency: deps.internetLatency,
    resolveGroupOrder: deps.resolveGroupOrder,
    resolveGroupIcon: deps.resolveGroupIcon,
    reloadConfig: deps.reloadConfig,
    restartKernel: deps.restartKernel,
    openDirectory: openTrayDirectory,
    copyText: (value) => clipboard.writeText(value),
    onCheckUpdate: deps.onCheckUpdate,
    onError: deps.onError
  })
  state.trayController = trayController

  const updateRuntimeAppearance = (): void => {
    const accent = resolveRuntimeAccent(
      deps.systemProxy.getStatus().phase,
      deps.tunStatusPhase()
    )
    const dark = nativeTheme.shouldUseDarkColors
    trayView.setRuntimeAppearance(accent, dark)
  }

  return {
    initialize(): Promise<void> {
      // Tray initialization no longer gates the startup chain: it runs next to the
      // recovery/replay work and is only joined by the CI hidden-start probe (and
      // nothing else — every consumer reads live status through the controller).
      return trayController.initialize().catch((error) => {
        console.error('[tray] initialization failed:', error)
      })
    },
    isReady(): boolean {
      return trayController.isReady()
    },
    dispose(): void {
      trayController.dispose()
      state.trayController = null
    },
    updateRuntimeAppearance,
    attachAppearanceListeners(
      unsubscribeProxy: () => void,
      unsubscribeTun: () => void
    ): () => void {
      const onUpdated = (): void => updateRuntimeAppearance()
      nativeTheme.on('updated', onUpdated)
      return () => {
        unsubscribeProxy()
        unsubscribeTun()
        nativeTheme.removeListener('updated', onUpdated)
      }
    }
  }
}
