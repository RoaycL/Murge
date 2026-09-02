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
; The restore is BEST-EFFORT for the uninstall path: exit 0 means disabled /
; restored / safe-conflict (an external edit was left intact), so the uninstaller
; continues normally. A non-zero exit or a missing/reboot-broken app binary means
; the restore could not be confirmed. We deliberately do NOT abort the uninstall
; in that case: the restore is performed by launching the *installed* executable,
; so any release whose app cannot boot (e.g. a crash bug) would otherwise make
; removal — and therefore every future upgrade — impossible, trapping the user on
; a broken install. Instead the uninstaller warns and continues, so the user is
; never locked out of uninstalling or upgrading; if the proxy was still
; registered it is reset manually in Windows Settings afterwards. The restore is
; still ATTEMPTED so the common healthy case keeps full protection.
!macro customInstall
  IfFileExists "$INSTDIR\resources\tun-service\tun-service.exe" 0 TunServiceInstallMissing
    DetailPrint "Installing privileged TUN lifecycle service..."
    ExecWait '"$INSTDIR\resources\tun-service\tun-service.exe" --install' $R0
    StrCmp $R0 0 TunServiceInstallDone TunServiceInstallFailed
    TunServiceInstallFailed:
      DetailPrint "TUN service installation failed with exit code $R0"
      MessageBox MB_ICONSTOP|MB_OK "TUN 服务安装失败，安装程序已中止。系统网络设置没有被启用。"
      SetErrorLevel 1
      Abort
  TunServiceInstallMissing:
    DetailPrint "TUN service executable is missing"
    MessageBox MB_ICONSTOP|MB_OK "安装包缺少 TUN 服务组件，安装程序已中止。"
    SetErrorLevel 1
    Abort
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
  IfFileExists "$INSTDIR\resources\tun-service\tun-service.exe" 0 TunServiceUninstallDone
    DetailPrint "Stopping and removing privileged TUN lifecycle service..."
    ExecWait '"$INSTDIR\resources\tun-service\tun-service.exe" --uninstall' $R0
    StrCmp $R0 0 TunServiceUninstallDone TunServiceUninstallFailed
    TunServiceUninstallFailed:
      DetailPrint "TUN service removal failed with exit code $R0; aborting uninstall"
      MessageBox MB_ICONSTOP|MB_OK "未能确认 TUN 内核已停止，因此已中止卸载，避免遗留网络状态。请重启电脑后重试。"
      SetErrorLevel 1
      Abort
  TunServiceUninstallDone:
!macroend
