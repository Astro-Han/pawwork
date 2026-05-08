!include nsDialogs.nsh
!include LogicLib.nsh

Var AddDesktopShortcutCheckbox
Var AddDesktopShortcut
Var PawWorkStandardShortcutName

LangString PawWorkAddDesktopShortcut ${LANG_ENGLISH} "Add desktop shortcut"
LangString PawWorkAddDesktopShortcut ${LANG_SIMPCHINESE} "添加桌面快捷方式"

!macro PAWWORK_STANDARD_SHORTCUT
  StrCpy $PawWorkStandardShortcutName "${SHORTCUT_NAME}"
  ${If} $LANGUAGE == ${LANG_SIMPCHINESE}
  ${AndIf} "${SHORTCUT_NAME}" == "PawWork"
    StrCpy $PawWorkStandardShortcutName "爪印"
  ${EndIf}
!macroend

!macro PAWWORK_REMOVE_STANDARD_SHORTCUTS
  !insertmacro PAWWORK_STANDARD_SHORTCUT
  Delete "$DESKTOP\$PawWorkStandardShortcutName.lnk"
  ${If} "${SHORTCUT_NAME}" == "PawWork"
    Delete "$DESKTOP\PawWork.lnk"
    Delete "$DESKTOP\爪印.lnk"
  ${EndIf}
!macroend

!macro PAWWORK_REMOVE_STANDARD_SHORTCUTS_IN_BOTH_SCOPES
  SetShellVarContext current
  !insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS
  SetShellVarContext all
  !insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS
!macroend

!macro PAWWORK_RESTORE_INSTALL_SCOPE
  ${If} $installMode == "all"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  PageEx custom
    PageCallbacks PawWorkDesktopShortcutPageCreate PawWorkDesktopShortcutPageLeave
    Caption " "
  PageExEnd
!macroend

Function "PawWorkDesktopShortcutPageCreate"
  ${If} ${isUpdated}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 0 100% 12u "$(PawWorkAddDesktopShortcut)"
  Pop $AddDesktopShortcutCheckbox
  ${NSD_Check} $AddDesktopShortcutCheckbox
  nsDialogs::Show
FunctionEnd

Function "PawWorkDesktopShortcutPageLeave"
  StrCpy $AddDesktopShortcut "0"
  ${NSD_GetState} $AddDesktopShortcutCheckbox $AddDesktopShortcut
FunctionEnd

!macro customInstall
  ${If} ${isUpdated}
    StrCpy $AddDesktopShortcut "PAWWORK_SKIP_DESKTOP_SHORTCUT"
  ${EndIf}

  ${If} $AddDesktopShortcut == ${BST_CHECKED}
    !insertmacro PAWWORK_STANDARD_SHORTCUT
    !insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS_IN_BOTH_SCOPES
    !insertmacro PAWWORK_RESTORE_INSTALL_SCOPE
    ${If} "${SHORTCUT_NAME}" == "PawWork"
    ${AndIf} $PawWorkStandardShortcutName == "爪印"
    ${AndIf} ${FileExists} "$DESKTOP\PawWork.lnk"
      Delete "$DESKTOP\PawWork.lnk"
    ${EndIf}
    CreateShortCut "$DESKTOP\$PawWorkStandardShortcutName.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\$PawWorkStandardShortcutName.lnk" "${APP_ID}"
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    !insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS_IN_BOTH_SCOPES
    !insertmacro PAWWORK_RESTORE_INSTALL_SCOPE
  ${EndIf}
!macroend
