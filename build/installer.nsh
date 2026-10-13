; Extra steps for the Windows uninstaller (electron-builder NSIS include).
; Before the files are removed, ask the installed Relay to take itself out of Claude Code
; (the "relay" tool, the skill and the hooks). Saved sign-ins and ~/.relay are never deleted here.
; Any failure is ignored: the uninstall always goes on.
!macro customUnInstall
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 +2
  nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --disconnect'
  Pop $0
!macroend
