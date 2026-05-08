!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include StdUtils.nsh
!include UAC.nsh

Var PawWorkStandardShortcutName

LangString PawWorkAddDesktopShortcut 1033 "Add desktop shortcut"
LangString PawWorkAddDesktopShortcut 2052 "添加桌面快捷方式"
LangString PawWorkShortcutOptions 1033 "Shortcut Options"
LangString PawWorkShortcutOptions 2052 "快捷方式选项"

!macro PAWWORK_STANDARD_SHORTCUT
  StrCpy $PawWorkStandardShortcutName "${SHORTCUT_NAME}"
  ${If} $LANGUAGE == 2052
  ${AndIf} "${SHORTCUT_NAME}" == "PawWork"
    StrCpy $PawWorkStandardShortcutName "爪印"
  ${ElseIf} $LANGUAGE == 2052
  ${AndIf} "${SHORTCUT_NAME}" == "PawWork Beta"
    StrCpy $PawWorkStandardShortcutName "爪印 Beta"
  ${ElseIf} $LANGUAGE == 2052
  ${AndIf} "${SHORTCUT_NAME}" == "PawWork Dev"
    StrCpy $PawWorkStandardShortcutName "爪印 Dev"
  ${EndIf}
!macroend

!macro PAWWORK_REMOVE_STANDARD_SHORTCUTS
  !insertmacro PAWWORK_STANDARD_SHORTCUT
  Delete "$DESKTOP\$PawWorkStandardShortcutName.lnk"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${If} "${SHORTCUT_NAME}" == "PawWork"
    Delete "$DESKTOP\PawWork.lnk"
    Delete "$DESKTOP\爪印.lnk"
  ${ElseIf} "${SHORTCUT_NAME}" == "PawWork Beta"
    Delete "$DESKTOP\PawWork Beta.lnk"
    Delete "$DESKTOP\爪印 Beta.lnk"
  ${ElseIf} "${SHORTCUT_NAME}" == "PawWork Dev"
    Delete "$DESKTOP\PawWork Dev.lnk"
    Delete "$DESKTOP\爪印 Dev.lnk"
  ${EndIf}
!macroend

!macro PAWWORK_REMOVE_PUBLIC_STANDARD_SHORTCUTS_ELEVATED
  # A per-user reinstall cannot remove Public Desktop shortcuts without elevation.
  ${IfNot} ${UAC_IsAdmin}
  ${AndIf} $installMode != "all"
  ${AndIf} $hasPerMachineInstallation == "1"
    SetShellVarContext all
    ${If} "${SHORTCUT_NAME}" == "PawWork"
      ${StdUtils.ExecShellWaitEx} $0 $1 "$SYSDIR\cmd.exe" "runas" '/C del /F /Q "$DESKTOP\PawWork.lnk" "$DESKTOP\爪印.lnk"'
    ${ElseIf} "${SHORTCUT_NAME}" == "PawWork Beta"
      ${StdUtils.ExecShellWaitEx} $0 $1 "$SYSDIR\cmd.exe" "runas" '/C del /F /Q "$DESKTOP\PawWork Beta.lnk" "$DESKTOP\爪印 Beta.lnk"'
    ${ElseIf} "${SHORTCUT_NAME}" == "PawWork Dev"
      ${StdUtils.ExecShellWaitEx} $0 $1 "$SYSDIR\cmd.exe" "runas" '/C del /F /Q "$DESKTOP\PawWork Dev.lnk" "$DESKTOP\爪印 Dev.lnk"'
    ${EndIf}
  ${EndIf}
!macroend

!macro PAWWORK_REMOVE_STANDARD_SHORTCUTS_IN_ALL_INSTALL_SCOPES
  SetShellVarContext current
  !insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS
  SetShellVarContext all
  !insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS
  !insertmacro PAWWORK_REMOVE_PUBLIC_STANDARD_SHORTCUTS_ELEVATED
!macroend

!macro PAWWORK_RESTORE_INSTALL_SCOPE
  ${If} $installMode == "all"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  Var AddDesktopShortcutCheckbox
  Var AddDesktopShortcut

  !macro customPageAfterChangeDir
    PageEx custom
      PageCallbacks PawWorkDesktopShortcutPageCreate PawWorkDesktopShortcutPageLeave
      Caption "$(PawWorkShortcutOptions)"
    PageExEnd
  !macroend

  Function "PawWorkDesktopShortcutPageCreate"
    ClearErrors
    ${GetParameters} $0
    ${GetOptions} $0 "--updated" $1
    ${IfNot} ${Errors}
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
    ClearErrors
    ${GetParameters} $0
    ${GetOptions} $0 "--updated" $1
    ${IfNot} ${Errors}
      StrCpy $AddDesktopShortcut "PAWWORK_SKIP_DESKTOP_SHORTCUT"
    ${EndIf}

    ${If} $AddDesktopShortcut == ${BST_CHECKED}
      !insertmacro PAWWORK_STANDARD_SHORTCUT
      !insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS_IN_ALL_INSTALL_SCOPES
      !insertmacro PAWWORK_RESTORE_INSTALL_SCOPE
      CreateShortCut "$DESKTOP\$PawWorkStandardShortcutName.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$DESKTOP\$PawWorkStandardShortcutName.lnk" "${APP_ID}"
    ${EndIf}
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  !macro customUnInstall
    ClearErrors
    ${GetParameters} $0
    ${GetOptions} $0 "--updated" $1
    ${If} ${Errors}
      !insertmacro PAWWORK_RESTORE_INSTALL_SCOPE
      !insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS
    ${EndIf}
  !macroend
!endif
