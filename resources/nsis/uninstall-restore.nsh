; Pre-uninstall system-proxy restore hook.
;
; NSIS macros are expanded by electron-builder's `nsis.include`, which injects
; this file into the generated uninstaller. `customUnInstall` runs BEFORE
; electron-builder deletes the installed app files (see
; node_modules/app-builder-lib/templates/nsis/uninstaller.nsh, where
; customUnInstall is inserted ahead of "delete the installed files"), so at this
; point the installed executable is still on disk and can be launched.
;
; Why: the feature takes over the per-user HKCU Internet Settings proxy and keeps
; an owned backup in the brand-independent app-data namespace. If the app is
; uninstalled while that proxy is still registered, the OS would be left pointing
; at a now-removed port. So before the files are gone we run the app's headless
; `--restore-system-proxy` path, which reads that backup, restores the exact
; pre-enable HKCU values only if the registry still matches the enabled state, and
; exits 0 both when it restored and when it reported a safe conflict (so it never
; overwrites an external edit).
;
; Both the system-proxy restore AND the privileged TUN service lifecycle are
; BEST-EFFORT: neither is allowed to hard-block install or uninstall. The proxy
; restore is performed by launching the *installed* executable, so any release
; whose app cannot boot (e.g. a crash bug) would otherwise make removal — and
; therefore every future upgrade — impossible, trapping the user on a broken
; install. The TUN service only serves the optional TUN-adapter mode; the core
; system-proxy mode launches the mihomo kernel directly and never needs it. On
; failure each path warns and continues, so the user is never locked out of
; installing, uninstalling or upgrading; if a proxy was still registered it is
; reset manually in Windows Settings afterwards, and a leftover TUN service can be
; removed in the Services snap-in. The operations are still ATTEMPTED so the
; common healthy case keeps full protection.
!macro customInstall
  IfFileExists "$INSTDIR\resources\tun-service\tun-service.exe" 0 TunServiceInstallMissing
    DetailPrint "Installing privileged TUN lifecycle service..."
    ExecWait '"$INSTDIR\resources\tun-service\tun-service.exe" --install' $R0
    StrCmp $R0 0 TunServiceInstallDone TunServiceInstallWarn
    TunServiceInstallWarn:
      DetailPrint "TUN service installation failed with exit code $R0; continuing install since TUN is optional"
      MessageBox MB_ICONEXCLAMATION|MB_OK "TUN 服务安装失败，本程序将继续完成安装。系统代理模式不受影响。若需 TUN 网卡模式，请以管理员身份重新安装并确认系统服务可正常启动。"
      Goto TunServiceInstallDone
  TunServiceInstallMissing:
    DetailPrint "TUN service executable is missing; continuing install since TUN is optional"
    MessageBox MB_ICONEXCLAMATION|MB_OK "安装包未包含 TUN 服务组件，本程序将继续完成安装。系统代理模式不受影响。"
  TunServiceInstallDone:
!macroend

!macro customUnInstall
  ; Attempt to restore the owned system proxy, but never hard-block removal.
  ; The restore runs the installed app binary, so a non-bootable release (crash
  ; bug) would otherwise make uninstall and upgrade impossible. Warn & continue.
  IfFileExists "$APPDATA\system-proxy\owned-backup.json" 0 SystemProxyUninstallRestoreDone
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SystemProxyUninstallRestoreWarn
      DetailPrint "Restoring owned system proxy before uninstall..."
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --restore-system-proxy' $R0
      DetailPrint "system-proxy restore exit code: $R0"
      StrCmp $R0 0 SystemProxyUninstallRestoreDone SystemProxyUninstallRestoreWarn
    SystemProxyUninstallRestoreWarn:
      DetailPrint "system-proxy restore not confirmed; continuing uninstall so removal is not blocked"
      MessageBox MB_ICONEXCLAMATION|MB_OK "未能确认系统代理已安全还原。为避免阻塞卸载（程序可能异常或已损坏），本程序将继续执行。若系统代理仍指向旧端口，请到「Windows 设置 → 网络和 Internet → 代理」关闭后重新启用。"
  SystemProxyUninstallRestoreDone:
  ; TUN removal is best-effort for the same reason as the proxy restore: a
  ; failure to remove the optional TUN service must never trap the user in a
  ; broken install. Warn and continue; a leftover service can be cleared in the
  ; Services snap-in (or by re-running the app once it is healthy).
  IfFileExists "$INSTDIR\resources\tun-service\tun-service.exe" 0 TunServiceUninstallDone
    DetailPrint "Stopping and removing privileged TUN lifecycle service..."
    ExecWait '"$INSTDIR\resources\tun-service\tun-service.exe" --uninstall' $R0
    StrCmp $R0 0 TunServiceUninstallDone TunServiceUninstallWarn
    TunServiceUninstallWarn:
      DetailPrint "TUN service removal failed with exit code $R0; continuing uninstall so removal is not blocked"
      MessageBox MB_ICONEXCLAMATION|MB_OK "未能确认 TUN 服务已移除。为避免阻塞卸载，本程序将继续执行。若残留的 TUN 服务需清理，请以管理员身份在「Windows 服务」中找到并停止、删除对应服务。"
  TunServiceUninstallDone:
!macroend
