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
; Both the system-proxy restore AND the privileged core service lifecycle are
; BEST-EFFORT: neither is allowed to hard-block install or uninstall. The proxy
; restore is performed by launching the *installed* executable, so any release
; whose app cannot boot (e.g. a crash bug) would otherwise make removal — and
; therefore every future upgrade — impossible, trapping the user on a broken
; install. The privileged service owns the mihomo process used by BOTH system
; proxy and TUN mode, so a failed service upgrade makes both modes unavailable.
; Installation retries once after the helper's own bounded file-replacement
; retry, covering transient SCM/antivirus locks without making removal impossible.
; A persistent failure is surfaced accurately and the installer remains usable
; for a repair run instead of trapping the user on a broken release.
!macro customInstall
  IfFileExists "$INSTDIR\resources\tun-service\tun-service.exe" 0 TunServiceInstallMissing
    DetailPrint "Installing privileged core lifecycle service..."
    ExecWait '"$INSTDIR\resources\tun-service\tun-service.exe" --install' $R0
    StrCmp $R0 0 TunServiceInstallDone TunServiceInstallRetry
    TunServiceInstallRetry:
      DetailPrint "Privileged core service installation failed with exit code $R0; retrying after service teardown..."
      Sleep 1500
      ExecWait '"$INSTDIR\resources\tun-service\tun-service.exe" --install' $R0
      StrCmp $R0 0 TunServiceInstallDone TunServiceInstallWarn
    TunServiceInstallWarn:
      DetailPrint "Privileged core service installation failed twice with exit code $R0; system proxy and TUN will remain unavailable until repaired"
      MessageBox MB_ICONEXCLAMATION|MB_OK "核心服务安装失败（错误码 $R0），系统代理和 TUN 模式暂时均不可用。请关闭 Murge 后，以管理员身份重新运行当前版本安装包完成修复。您的配置不会丢失。"
      Goto TunServiceInstallDone
  TunServiceInstallMissing:
    DetailPrint "Privileged core service executable is missing; system proxy and TUN cannot start"
    MessageBox MB_ICONEXCLAMATION|MB_OK "安装包缺少核心服务组件，系统代理和 TUN 模式均不可用。请重新下载完整安装包后安装。"
  TunServiceInstallDone:
  ; electron-builder preserves an existing desktop shortcut during an upgrade.
  ; Its target still points at the replaced executable, but Explorer can retain
  ; the old icon for that unchanged .lnk path. Recreate only an existing link
  ; (never restore one the user intentionally removed), keep the same AUMID, and
  ; explicitly notify Shell after the new executable is already on disk.
  IfFileExists "$newDesktopLink" 0 DesktopIconRefreshDone
    DetailPrint "Refreshing the existing desktop shortcut icon..."
    Delete "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  DesktopIconRefreshDone:
!macroend

!macro customUnInstall
  ; perMachine installers enter this hook with the all-users shell context,
  ; where $APPDATA resolves to ProgramData. Proxy ownership is per-user under
  ; Roaming AppData, so explicitly restore the current-user context first.
  SetShellVarContext current
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
  ; An updater invokes the old uninstaller before customInstall upgrades the
  ; existing service in place. Keep the protected state directory on that path:
  ; it contains geodata/provider caches required for an offline first start.
  ; A real user uninstall still removes the service and its protected state.
  ${if} ${isUpdated}
    DetailPrint "Preserving privileged TUN service state for in-place upgrade..."
  ${else}
    ; Service removal is best-effort for the same reason as the proxy restore: a
    ; failure to remove the privileged core service must never trap the user in a
    ; broken install. Warn and continue; a leftover service can be cleared in
    ; the Services snap-in (or by re-running the app once it is healthy).
    IfFileExists "$INSTDIR\resources\tun-service\tun-service.exe" 0 TunServiceUninstallDone
      DetailPrint "Stopping and removing privileged TUN lifecycle service..."
      ExecWait '"$INSTDIR\resources\tun-service\tun-service.exe" --uninstall' $R0
      StrCmp $R0 0 TunServiceUninstallDone TunServiceUninstallWarn
      TunServiceUninstallWarn:
        DetailPrint "TUN service removal failed with exit code $R0; continuing uninstall so removal is not blocked"
        MessageBox MB_ICONEXCLAMATION|MB_OK "未能确认 TUN 服务已移除。为避免阻塞卸载，本程序将继续执行。若残留的 TUN 服务需清理，请以管理员身份在「Windows 服务」中找到并停止、删除对应服务。"
    TunServiceUninstallDone:
  ${endif}
  ; The scheduled-task auto-start registration (see
  ; src/main/startup/scheduled-task-adapter.ts) must not outlive the app: a
  ; leftover task fires a failing launch at every future logon. The task name is
  ; the brand-stable appId, which electron-builder exposes here as ${APP_ID}.
  ; Best-effort like every other uninstall step — a failure never blocks removal.
  DetailPrint "Removing auto-start scheduled task..."
  nsExec::Exec 'schtasks /delete /tn "${APP_ID}" /f'
  Pop $R0
  DetailPrint "auto-start task removal exit code: $R0"
  ; schtasks may be unavailable or denied by enterprise policy, in which case
  ; the app deliberately falls back to Electron's per-user Run entry. Remove
  ; that stable appId-named value too so uninstall never leaves a dead launch.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
!macroend
