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
; The restore is best-effort and must NOT block or fail the uninstall: if the app
; binary is missing or the restore errors we log it and let the uninstaller
; continue, so the user is never stuck mid-uninstall. The restore exit code is
; surfaced in the installer log for CI.
!macro customUnInstall
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SystemProxyUninstallRestoreDone
    DetailPrint "Restoring owned system proxy before uninstall..."
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --restore-system-proxy' $R0
    DetailPrint "system-proxy restore exit code: $R0"
  SystemProxyUninstallRestoreDone:
!macroend
