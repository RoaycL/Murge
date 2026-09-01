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
; The restore is fail-closed for the uninstall path: exit 0 means disabled /
; restored / safe-conflict (an external edit was left intact), so the uninstaller
; continues normally. A non-zero exit means the restore could not be applied —
; most commonly the backup was corrupted or unreadable, so we would otherwise
; leave the OS pointing at a now-removed port. In that case we ABORT the whole
; uninstall (this runs inside the required "Uninstall" section, so `Abort` stops
; the uninstaller before it deletes the installed files), keeping the app binary
; and its restore tool so the user can retry, and surface a message. This is the
; only way to guarantee the system proxy is never left broken by a failed uninstall.
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
  ; The restore executable is needed only when this user actually has a durable
  ; ownership backup. Avoid starting Electron during an ordinary uninstall that
  ; never enabled system proxy. If the backup exists, the restore remains
  ; strictly fail-closed below; a corrupted or unreadable backup aborts uninstall.
  IfFileExists "$APPDATA\system-proxy\owned-backup.json" 0 SystemProxyUninstallRestoreDone
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SystemProxyUninstallRestoreFailed
    DetailPrint "Restoring owned system proxy before uninstall..."
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --restore-system-proxy' $R0
    DetailPrint "system-proxy restore exit code: $R0"
    StrCmp $R0 0 SystemProxyUninstallRestoreDone SystemProxyUninstallRestoreFailed
    SystemProxyUninstallRestoreFailed:
      DetailPrint "system-proxy restore failed; aborting uninstall to protect the OS proxy settings"
      MessageBox MB_ICONSTOP|MB_OK "卸载前检查：未能安全还原系统代理设置，已中止卸载以保留程序与还原工具。请关闭代理相关的提示后重试。"
      SetErrorLevel 1
      Abort
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
