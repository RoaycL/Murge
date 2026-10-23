; Installer hooks for the Tauri NSIS bundle (bundle.windows.nsis.installerHooks).
;
; This is the Tauri port of the Electron installer's resources/nsis/uninstall-restore.nsh.
; The bundler !includes this file at the top of its installer.nsi and inserts the
; four NSIS_HOOK_* macros into the install and uninstall sections. Tauri defines
; PRODUCTNAME, MAINBINARYNAME, BUNDLEID, INSTALLMODE and the $UpdateMode and
; $PassiveMode variables before any macro below is expanded.
;
; Layout this file relies on (see scripts/tauri-package.mjs):
;   $INSTDIR\${MAINBINARYNAME}.exe              the GUI, pinned by the TUN service
;   $INSTDIR\resources\tun-service\             tun-service.exe + service-template.json
;   $INSTDIR\resources\bin\                     the pinned mihomo archive
;   $INSTDIR\resources\geodata\                 geodata seeded into the service state
;   $INSTDIR\resources\startup\register-task.ps1
; tun-service.exe --install derives the archive, geodata and GUI paths from its
; own directory, so the GUI it trusts is exactly $INSTDIR\${MAINBINARYNAME}.exe.
;
; Every step is best effort except the Electron takeover: a failed proxy restore
; or service step must never trap the user in an install they cannot repair or
; remove, but a half-removed Electron install next to the new files would leave
; a second uninstaller that deletes the new exe and the service.
;
; Update paths:
;   - Tauri updater: the installer runs with /P /UPDATE and never runs the old
;     uninstaller, so only the install hooks run. --install stops the service,
;     repins the new exe hash and starts it again; service state and the startup
;     task are kept.
;   - A newer installer run by hand: Tauri offers "uninstall before installing",
;     which runs the uninstall hooks without /UPDATE. The service and its state
;     are removed and recreated by the install hooks; the startup intent is
;     carried across in HKCU (see MURGE_STARTUP_MARKER_VALUE).
;   - Last Electron release: it launches this installer with /P. The Electron
;     uninstaller is run with --updated, which restores the owned proxy and keeps
;     the service, its state and the startup task, then --install repins the trust
;     from the Electron exe to the Tauri exe at the same path.

; electron-builder registers the Electron install under UUID v5 of the appId in
; its namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3. tests/tauri-package.test.ts
; recomputes it from brand.config.json.
!define MURGE_ELECTRON_GUID "3a98ddda-fe2a-5afb-97ed-078f905c6c1d"
!define MURGE_ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${MURGE_ELECTRON_GUID}"
!define MURGE_ELECTRON_INSTALL_KEY "Software\${MURGE_ELECTRON_GUID}"
; Startup intent is carried from an uninstall to the next install in the
; HKCU "${MANUPRODUCTKEY}" value below (Tauri's own per-product key).
!define MURGE_STARTUP_MARKER_VALUE "StartupWasEnabled"
; Consumed by the app on its next launch (settings.rs INSTALLER_CHANNEL_RESET_FILE).
!define MURGE_CHANNEL_RESET_FILE "update-channel-reset"

Var MurgeStartupWasEnabled
Var MurgeElectronUninstaller
Var MurgeElectronDir

; Sets $MurgeStartupWasEnabled to 1 when this user currently starts the app at
; logon through the scheduled task or a Run value.
!macro MURGE_CAPTURE_STARTUP_INTENT TASK_NAME RUN_NAME
  !define MURGE_ID ${__LINE__}
  StrCpy $MurgeStartupWasEnabled "0"
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${RUN_NAME}"
  StrCmp $R8 "" 0 murge_startup_on_${MURGE_ID}
  ; Older Electron builds registered auto-start under this legacy Run name.
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${PRODUCTNAME}"
  StrCmp $R8 "" 0 murge_startup_on_${MURGE_ID}
  ReadRegStr $R8 HKCU "${MANUPRODUCTKEY}" "${MURGE_STARTUP_MARKER_VALUE}"
  StrCmp $R8 "1" murge_startup_on_${MURGE_ID}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if ((Get-ScheduledTask -TaskName ${TASK_NAME} -ErrorAction Stop).Settings.Enabled) { exit 0 } else { exit 1 }"'
  Pop $R8
  Pop $R9
  StrCmp $R8 0 0 murge_startup_done_${MURGE_ID}
  murge_startup_on_${MURGE_ID}:
    StrCpy $MurgeStartupWasEnabled "1"
  murge_startup_done_${MURGE_ID}:
  !undef MURGE_ID
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Close a running GUI first (an exiting Electron build included). The stock
  ; check after this hook would do it too, but only after the takeover below.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  SetShellVarContext current
  !insertmacro MURGE_CAPTURE_STARTUP_INTENT "${BUNDLEID}" "${BUNDLEID}"
  SetShellVarContext all

  ; --- Electron takeover -----------------------------------------------------
  StrCpy $R3 "-"
  ReadRegStr $R0 HKLM "${MURGE_ELECTRON_UNINSTALL_KEY}" "UninstallString"
  StrCmp $R0 "" MurgeElectronTakeoverDone
  ; UninstallString is '"<dir>\Uninstall <name>.exe" /allusers'.
  StrCpy $MurgeElectronUninstaller ""
  StrCpy $R1 $R0 1
  StrCmp $R1 '"' 0 MurgeElectronTakeoverFailed
  StrCpy $R2 1
  MurgeElectronQuoteLoop:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" MurgeElectronTakeoverFailed
    StrCmp $R1 '"' MurgeElectronQuoteFound
    IntOp $R2 $R2 + 1
    Goto MurgeElectronQuoteLoop
  MurgeElectronQuoteFound:
    IntOp $R2 $R2 - 1
    StrCpy $MurgeElectronUninstaller $R0 $R2 1
  IfFileExists "$MurgeElectronUninstaller" 0 MurgeElectronTakeoverFailed
  ReadRegStr $MurgeElectronDir HKLM "${MURGE_ELECTRON_INSTALL_KEY}" "InstallLocation"
  StrCmp $MurgeElectronDir "" 0 MurgeElectronDirKnown
    ${GetParent} "$MurgeElectronUninstaller" $MurgeElectronDir
  MurgeElectronDirKnown:
  StrCmp $MurgeElectronDir "" MurgeElectronTakeoverFailed
  DetailPrint "Migrating the previous ${PRODUCTNAME} installation in $MurgeElectronDir..."
  ; Run a copy, as electron-builder does: the original lives in the directory
  ; it is about to delete. --updated restores the owned system proxy and keeps
  ; the privileged service, its protected state and the startup task.
  InitPluginsDir
  CopyFiles /SILENT "$MurgeElectronUninstaller" "$PLUGINSDIR\previous-uninstaller.exe"
  ClearErrors
  ExecWait '"$PLUGINSDIR\previous-uninstaller.exe" /S /allusers /KEEP_APP_DATA --updated _?=$MurgeElectronDir' $R3
  IfErrors MurgeElectronTakeoverFailed
  StrCmp $R3 0 0 MurgeElectronTakeoverFailed
  ; The Electron uninstaller removes its own registry entries; make sure, so a
  ; stale "Apps" entry can never run against the new files.
  ReadRegStr $R0 HKLM "${MURGE_ELECTRON_UNINSTALL_KEY}" "UninstallString"
  StrCmp $R0 "" MurgeElectronTakeoverDone MurgeElectronTakeoverFailed
  MurgeElectronTakeoverFailed:
    DetailPrint "Previous installation could not be removed (exit code $R3)"
    MessageBox MB_ICONSTOP|MB_OK "无法移除旧版 ${PRODUCTNAME}（错误码 $R3）。请关闭 ${PRODUCTNAME} 后重新运行安装包；如仍失败，请先在「设置 → 应用」中卸载旧版本，您的配置不会丢失。" /SD IDOK
    Abort
  MurgeElectronTakeoverDone:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; --- Privileged core service ----------------------------------------------
  ; --install creates or upgrades the LocalSystem service, seeds geodata, and
  ; pins $INSTDIR\${MAINBINARYNAME}.exe by path and SHA-256 as the only client.
  IfFileExists "$INSTDIR\resources\tun-service\tun-service.exe" 0 MurgeServiceMissing
    DetailPrint "Installing privileged core lifecycle service..."
    nsExec::ExecToStack '"$INSTDIR\resources\tun-service\tun-service.exe" --install'
    Pop $R0
    Pop $R1
    StrCmp $R0 0 MurgeServiceDone
    DetailPrint "Privileged core service installation failed with exit code $R0: $R1"
    DetailPrint "Retrying after service teardown..."
    Sleep 1500
    nsExec::ExecToStack '"$INSTDIR\resources\tun-service\tun-service.exe" --install'
    Pop $R0
    Pop $R1
    StrCmp $R0 0 MurgeServiceDone
    DetailPrint "Privileged core service installation failed twice with exit code $R0: $R1"
    MessageBox MB_ICONEXCLAMATION|MB_OK "核心服务安装失败（错误码 $R0），系统代理和 TUN 模式暂时均不可用。$\r$\n$\r$\n详细原因：$R1$\r$\n$\r$\n请关闭 ${PRODUCTNAME} 后，以管理员身份重新运行当前版本安装包完成修复。您的配置不会丢失。" /SD IDOK
    Goto MurgeServiceDone
  MurgeServiceMissing:
    DetailPrint "Privileged core service executable is missing; system proxy and TUN cannot start"
    MessageBox MB_ICONEXCLAMATION|MB_OK "安装包缺少核心服务组件，系统代理和 TUN 模式均不可用。请重新下载完整安装包后安装。" /SD IDOK
  MurgeServiceDone:

  ; --- Per-user startup task ------------------------------------------------
  ; The installer already holds the one-time administrator authorization, so
  ; it registers the task (disabled unless the user had opted in) and the GUI
  ; only toggles it. register-task.ps1 keeps an existing task's enabled state.
  SetShellVarContext current
  IfFileExists "$INSTDIR\resources\startup\register-task.ps1" 0 MurgeStartupScriptMissing
    DetailPrint "Registering per-user startup task..."
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\startup\register-task.ps1" -TaskName "${BUNDLEID}" -ExecutablePath "$INSTDIR\${MAINBINARYNAME}.exe" -PreviouslyEnabled "$MurgeStartupWasEnabled"'
    Pop $R0
    Pop $R1
    StrCmp $R0 0 MurgeStartupRegistered MurgeStartupFailed
  MurgeStartupScriptMissing:
    StrCpy $R0 "missing script"
    StrCpy $R1 "startup task registration script is missing"
  MurgeStartupFailed:
    DetailPrint "Startup task registration failed ($R0): $R1"
    StrCmp $MurgeStartupWasEnabled "1" 0 MurgeStartupEnd
      ; Keep the user's auto-start working through the Run-key fallback the
      ; GUI also understands, then report the best-effort failure.
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${BUNDLEID}" '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden'
      MessageBox MB_ICONEXCLAMATION|MB_OK "未能注册高优先级开机启动任务，原有开机启动设置将保留为兼容模式。请以管理员身份重新运行安装包修复。" /SD IDOK
    Goto MurgeStartupEnd
  MurgeStartupRegistered:
    ; Only retire the fallback entries once the task is verified, so startup
    ; never launches twice and never silently disappears.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${BUNDLEID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${PRODUCTNAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  MurgeStartupEnd:
  DeleteRegValue HKCU "${MANUPRODUCTKEY}" "${MURGE_STARTUP_MARKER_VALUE}"

  ; --- Update channel ---------------------------------------------------------
  ; Anything but this build's own self-update (a manual install, an Electron
  ; takeover, a channel switch from the stable build) means this build was
  ; chosen. The Electron build stores "stable" in each user's settings file,
  ; so stamp the install: every user's first launch after a new stamp follows
  ; the experimental channel instead of switching straight back
  ; (settings.rs INSTALLER_CHANNEL_RESET_FILE). The stamp sits in $INSTDIR,
  ; not one user's profile: this is a per-machine install, and the account
  ; that elevated it may not be the one that uses it.
  ${If} $UpdateMode <> 1
    ClearErrors
    FileOpen $R2 "$INSTDIR\${MURGE_CHANNEL_RESET_FILE}" w
    IfErrors +3
      FileWrite $R2 "experimental"
      FileClose $R2
  ${EndIf}
  SetShellVarContext all
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The proxy restore below must not race a running GUI that could re-apply it.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; --- System proxy ----------------------------------------------------------
  ; Proxy ownership is per user under Roaming AppData; a perMachine uninstaller
  ; starts in the all-users context where $APPDATA is ProgramData.
  SetShellVarContext current
  ; An update keeps the app's proxy ownership: the relaunched app adopts it.
  ; (Tauri's own update path never runs this uninstaller; this guards a
  ; template that does.)
  ${If} $UpdateMode = 1
    Goto MurgeProxyDone
  ${EndIf}
  IfFileExists "$APPDATA\${BUNDLEID}\system-proxy\owned-backup.json" 0 MurgeProxyDone
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 MurgeProxyWarn
      DetailPrint "Restoring owned system proxy before uninstall..."
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore-system-proxy' $R0
      DetailPrint "system-proxy restore exit code: $R0"
      StrCmp $R0 0 MurgeProxyDone
    MurgeProxyWarn:
      DetailPrint "system-proxy restore not confirmed; continuing so removal is not blocked"
      MessageBox MB_ICONEXCLAMATION|MB_OK "未能确认系统代理已安全还原。为避免阻塞卸载（程序可能异常或已损坏），本程序将继续执行。若系统代理仍指向旧端口，请到「Windows 设置 → 网络和 Internet → 代理」关闭后重新启用。" /SD IDOK
  MurgeProxyDone:

  ${If} $UpdateMode = 1
    DetailPrint "Preserving privileged TUN service and startup task for update..."
  ${Else}
    ; The install stamp is not in the bundler's file list.
    Delete "$INSTDIR\${MURGE_CHANNEL_RESET_FILE}"

    ; --- Startup task ---------------------------------------------------------
    ; Remember an enabled auto-start so a reinstall right after this keeps it.
    !insertmacro MURGE_CAPTURE_STARTUP_INTENT "${BUNDLEID}" "${BUNDLEID}"
    StrCmp $MurgeStartupWasEnabled "1" 0 +2
      WriteRegStr HKCU "${MANUPRODUCTKEY}" "${MURGE_STARTUP_MARKER_VALUE}" "1"
    DetailPrint "Removing auto-start scheduled task..."
    nsExec::Exec 'schtasks /delete /tn "${BUNDLEID}" /f'
    Pop $R0
    DetailPrint "auto-start task removal exit code: $R0"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${BUNDLEID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${BUNDLEID}"

    ; --- Privileged core service ----------------------------------------------
    ; Stops the service (which stops its mihomo), deletes it and removes its
    ; protected ProgramData state. Best effort: never block removal.
    IfFileExists "$INSTDIR\resources\tun-service\tun-service.exe" 0 MurgeServiceRemoved
      DetailPrint "Stopping and removing privileged TUN lifecycle service..."
      ExecWait '"$INSTDIR\resources\tun-service\tun-service.exe" --uninstall' $R0
      StrCmp $R0 0 MurgeServiceRemoved
      DetailPrint "TUN service removal failed with exit code $R0; continuing so removal is not blocked"
      MessageBox MB_ICONEXCLAMATION|MB_OK "未能确认 TUN 服务已移除。为避免阻塞卸载，本程序将继续执行。若残留的 TUN 服务需清理，请以管理员身份在「Windows 服务」中找到并停止、删除对应服务。" /SD IDOK
    MurgeServiceRemoved:
  ${EndIf}
  SetShellVarContext all
!macroend
