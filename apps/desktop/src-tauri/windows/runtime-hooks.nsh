; Stop only the installed user's private local services before replacing files.
; Toolsets installed outside this package and user data remain installed.
!define AIXAND_WINDOWS_SOURCE "${__FILEDIR__}"
!ifndef AIXAND_MAINTENANCE_HELPER
  !define AIXAND_MAINTENANCE_HELPER "${AIXAND_WINDOWS_SOURCE}\..\resources\runtime\cleanup_processes.py"
!endif
!ifndef AIXAND_MAINTENANCE_PROVIDER
  !define AIXAND_MAINTENANCE_PROVIDER "${AIXAND_WINDOWS_SOURCE}\..\resources\runtime\provider-cleanup.py"
!endif

; Setup's Uninstall choice normally runs the installed uninstaller, which may
; still contain a preview cleanup bug. Refresh only its verified compatible
; helper before launching it. No services or selected data are removed here.
!macro AIXAND_PREPARE_MAINTENANCE_UNINSTALL
  Push $0
  Push $1
  Push $OUTDIR
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=aixand-maintenance-update.py "${AIXAND_WINDOWS_SOURCE}\maintenance-update.py"
  File /oname=aixand-cleanup-processes.py "${AIXAND_MAINTENANCE_HELPER}"
  File /oname=aixand-provider-cleanup.py "${AIXAND_MAINTENANCE_PROVIDER}"
  ClearErrors
  nsExec::ExecToStack '"$INSTDIR\runtime\python\python.exe" -I -B "$PLUGINSDIR\aixand-maintenance-update.py" --runtime "$INSTDIR\runtime" --payload "$PLUGINSDIR\aixand-cleanup-processes.py" --provider-payload "$PLUGINSDIR\aixand-provider-cleanup.py"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Setup could not prepare the current cleanup checklist.$\r$\n$1$\r$\nChoose Add/Reinstall components and finish installation before uninstalling. Your selected data has not been removed."
    Pop $1
    SetOutPath "$1"
    Pop $1
    Pop $0
    Abort
  ${EndIf}
  Pop $1
  SetOutPath "$1"
  Pop $1
  Pop $0
  ClearErrors
!macroend

!macro AIXAND_STOP_LOCAL_RUNTIME
  !define /redef AIXAND_STOP_LABEL "aixand_stop_${__LINE__}"
  IfFileExists "$INSTDIR\runtime\bin\aixand-runtime.exe" 0 ${AIXAND_STOP_LABEL}_done
  nsExec::ExecToStack '"$INSTDIR\runtime\bin\aixand-runtime.exe" stop'
  Pop $0
  Pop $1
  StrCmp $0 "0" ${AIXAND_STOP_LABEL}_done
  MessageBox MB_ICONSTOP "Aixand local services could not stop. Close Aixand and stop the local runtime before continuing.$\r$\n$1"
  Abort
  ${AIXAND_STOP_LABEL}_done:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AIXAND_STOP_LOCAL_RUNTIME
  ; NSIS reinstalls overwrite matching files but retain obsolete resources.
  ; Product artifacts have exact inventories, so an old content-addressed
  ; object would invalidate the new kit. Replace only Suite-owned software;
  ; local workspace data and shared products are siblings of this directory.
  RMDir /r "$INSTDIR\runtime"
  IfFileExists "$INSTDIR\runtime\*" aixand_runtime_cleanup_failed aixand_runtime_cleanup_done
  aixand_runtime_cleanup_failed:
  MessageBox MB_ICONSTOP "Aixand could not replace its previous runtime. Close its running processes and retry setup. Your workspace data and shared products are preserved."
  Abort
  aixand_runtime_cleanup_done:
  ClearErrors
!macroend

; Older previews included provider engines. NSIS can upgrade in place, leaving
; resources absent from the new package behind. Remove only that private payload.
!macro NSIS_HOOK_POSTINSTALL
  RMDir /r "$INSTDIR\runtime\providers"
  RMDir /r "$INSTDIR\runtime\python\Lib\site-packages\claude_agent_sdk\_bundled"
  RMDir /r "$INSTDIR\runtime\voice\python\Lib\site-packages\claude_agent_sdk\_bundled"
  RMDir /r "$INSTDIR\runtime\python\Lib\site-packages\google\antigravity"
  RMDir /r "$INSTDIR\runtime\voice\python\Lib\site-packages\google\antigravity"
  Delete "$INSTDIR\runtime\bin\codex.exe"
  Delete "$INSTDIR\runtime\bin\claude.exe"
  IfFileExists "$INSTDIR\runtime\providers\*" aixand_provider_cleanup_failed
  IfFileExists "$INSTDIR\runtime\python\Lib\site-packages\claude_agent_sdk\_bundled\*" aixand_provider_cleanup_failed
  IfFileExists "$INSTDIR\runtime\voice\python\Lib\site-packages\claude_agent_sdk\_bundled\*" aixand_provider_cleanup_failed
  IfFileExists "$INSTDIR\runtime\python\Lib\site-packages\google\antigravity\*" aixand_provider_cleanup_failed
  IfFileExists "$INSTDIR\runtime\voice\python\Lib\site-packages\google\antigravity\*" aixand_provider_cleanup_failed
  IfFileExists "$INSTDIR\runtime\bin\codex.exe" aixand_provider_cleanup_failed
  IfFileExists "$INSTDIR\runtime\bin\claude.exe" aixand_provider_cleanup_failed aixand_provider_cleanup_done
  aixand_provider_cleanup_failed:
  MessageBox MB_ICONSTOP "Aixand could not remove an older private provider engine. Close its running processes and reinstall Aixand. Your account data and separately installed tools are preserved."
  Abort
  aixand_provider_cleanup_done:
  ClearErrors
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AIXAND_STOP_LOCAL_RUNTIME
  ; Updates, passive setup, and silent uninstall preserve optional components.
  ; Interactive uninstall uses the same native checklist as desktop reset.
  ${IfNot} ${Silent}
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
    !insertmacro CheckIfAppIsRunning "$INSTDIR\aixand-desktop.exe" "${PRODUCTNAME}"
    ClearErrors
    ${If} $DeleteAppDataCheckboxState == 1
      ExecWait '"$INSTDIR\aixand-desktop.exe" --cleanup-uninstall --cleanup-desktop-selected' $0
    ${Else}
      ExecWait '"$INSTDIR\aixand-desktop.exe" --cleanup-uninstall' $0
    ${EndIf}
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "The cleanup checklist could not open. Restore or reinstall Aixand and retry uninstall. Your data was retained."
      Abort
    ${EndIf}
    ${If} $0 == 10
      ; The native webview clear API is asynchronous. Remove its entire private
      ; browser directory after the cleanup window exits as well.
      StrCpy $DeleteAppDataCheckboxState 1
    ${ElseIf} $0 == 0
      ; The last checklist choice wins, including unchecking desktop removal.
      StrCpy $DeleteAppDataCheckboxState 0
    ${Else}
      MessageBox MB_ICONINFORMATION "Aixand uninstall was cancelled. The application is still installed."
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
  nsExec::ExecToStack '"$INSTDIR\runtime\bin\aixand-runtime.exe" uninstall-products'
  Pop $0
  Pop $1
  StrCmp $0 "0" aixand_private_products_removed
  MessageBox MB_ICONSTOP "Private tool cleanup could not finish. Your data and shared products were retained.$\r$\n$1"
  Abort
  aixand_private_products_removed:
!macroend
