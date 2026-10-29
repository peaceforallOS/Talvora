; Windows installer additions (electron-builder "nsis.include", see package.json):
; a "Shortcuts" page after the folder page, letting the user choose the desktop and Start menu
; shortcuts. electron-builder creates both; the ones left unticked are removed again. Updates run
; with --updated, which skips this page and keeps whatever shortcuts the user has.

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var vcDesktopBox
  Var vcStartMenuBox
  Var vcDesktopShortcut
  Var vcStartMenuShortcut
!endif

!macro customPageAfterChangeDir
  Page custom vcShortcutsPage vcShortcutsPageLeave

  Function vcShortcutsPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose where VideoCall should appear."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 10u 100% 12u "Create a &desktop shortcut"
    Pop $vcDesktopBox
    ${NSD_Check} $vcDesktopBox
    ${NSD_CreateCheckbox} 0 30u 100% 12u "Add VideoCall to the &Start menu"
    Pop $vcStartMenuBox
    ${NSD_Check} $vcStartMenuBox
    nsDialogs::Show
  FunctionEnd

  Function vcShortcutsPageLeave
    ${NSD_GetState} $vcDesktopBox $vcDesktopShortcut
    ${NSD_GetState} $vcStartMenuBox $vcStartMenuShortcut
  FunctionEnd
!macroend

; Runs after the files and shortcuts are in place. Unticked = "0"; an empty value (silent install,
; or the page skipped on update) keeps the shortcuts.
!macro customInstall
  ${If} $vcDesktopShortcut == "0"
    Delete "$newDesktopLink"
  ${EndIf}
  ${If} $vcStartMenuShortcut == "0"
    Delete "$newStartMenuLink"
    ; "Run VideoCall" on the last page used the Start menu shortcut
    StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend
