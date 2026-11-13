; Allradione installation hooks. Keep the appId/productName stable across updates.
; Standard electron-builder NSIS owns installed program files, shortcuts, and registry.
; This hook only removes a positively identified Allradione user-data directory.
; Custom includes precede electron-builder's standard template includes.
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifdef BUILD_UNINSTALLER
Function un.AllradioneRemoveTree
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r3'
  ${If} $3 != -1
    IntOp $4 $3 & 0x400 ; FILE_ATTRIBUTE_REPARSE_POINT
    ${If} $4 != 0
      ; Remove links themselves. Never traverse junctions into other user folders.
      IntOp $4 $3 & 0x10
      ${If} $4 != 0
        RMDir "$0"
      ${Else}
        Delete "$0"
      ${EndIf}
    ${Else}
      IntOp $4 $3 & 0x10 ; FILE_ATTRIBUTE_DIRECTORY
      ${If} $4 != 0
        FindFirst $1 $2 "$0\*.*"
        ${DoWhile} $2 != ""
          ${If} $2 != "."
          ${AndIf} $2 != ".."
            Push "$0\$2"
            Call un.AllradioneRemoveTree
          ${EndIf}
          FindNext $1 $2
        ${Loop}
        FindClose $1
        RMDir "$0"
      ${Else}
        Delete "$0"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!macro customUnInstall
  ${IfNot} ${isUpdated}
    Push $0
    Push $1
    Push $2
    Push $3
    SetShellVarContext current
    ; The helper refuses unrelated desktop files and verifies its installed location.
    ${If} ${FileExists} "$INSTDIR\resources\desktop-launcher.exe"
      ExecWait '"$INSTDIR\resources\desktop-launcher.exe" --remove-desktop --quiet' $3
    ${EndIf}
    ReadRegStr $1 HKCU "Software\Allradione" AppId
    ReadRegStr $2 HKCU "Software\Allradione" InstallLocation
    ${If} $1 == "io.github.samueltoken.allradione"
    ${AndIf} $2 == "$INSTDIR"
      DeleteRegKey HKCU "Software\Allradione"
    ${EndIf}
    StrCpy $0 "$APPDATA\Allradione"
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r3'
    IntOp $3 $3 & 0x400
    ${If} $3 == 0
      ClearErrors
      FileOpen $1 "$0\allradione-owner.txt" r
      ${IfNot} ${Errors}
        FileRead $1 $2
        FileClose $1
        ${If} $2 == "io.github.samueltoken.allradione"
          Push "$0"
          Call un.AllradioneRemoveTree
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var AllradioneHadInstall
Var AllradioneParentPid
Var AllradioneConfirmed

; Cancel on the welcome page keeps the listening session alive.
Function AllradioneWelcomePre
  StrCmp $AllradioneParentPid "" 0 +2
    Abort
FunctionEnd

Function AllradioneWelcomeLeave
  Push $0
  Push $1
  ClearErrors
  FileOpen $0 "$EXEDIR\setup-confirmed" w
  IfErrors updateCannotStart
  FileWrite $0 "1"
  FileClose $0
  StrCpy $AllradioneConfirmed "1"
  StrCpy $1 $AllradioneParentPid
  System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i r1) p.r0'
  ${If} $0 P<> 0
    System::Call 'kernel32::WaitForSingleObject(p r0, i 20000) i.r1'
    System::Call 'kernel32::CloseHandle(p r0)'
    ${If} $1 != 0
      Goto updateCannotStart
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
  Return
  updateCannotStart:
    MessageBox MB_ICONEXCLAMATION|MB_OK "Allradione could not close for the update. Close the app and select Next again."
    Pop $1
    Pop $0
    Abort
FunctionEnd

!macro customInstallMode
  ; In-app updates reuse the registered installation directory and scope.
  ${If} $AllradioneParentPid != ""
    ${If} $hasPerUserInstallation == "1"
      StrCpy $isForceCurrentInstall "1"
    ${ElseIf} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE AllradioneWelcomePre
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE AllradioneWelcomeLeave
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customHeader
Function .onGUIEnd
  ${If} $AllradioneConfirmed == "1"
  ${AndIf} ${FileExists} "$INSTDIR\Allradione.exe"
    ; Finish can leave the app closed. Its background cleanup waits for the
    ; Setup file lock to be released without opening a player window.
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    ${StdUtils.ExecShellAsUser} $1 "$INSTDIR\Allradione.exe" "open" "--cleanup-update=$0"
  ${EndIf}
FunctionEnd
!macroend
!endif

!macro customInit
  StrCpy $AllradioneHadInstall "0"
  StrCpy $AllradioneParentPid ""
  StrCpy $AllradioneConfirmed ""
  ${If} ${isUpdated}
  ${AndIfNot} ${Silent}
  ${AndIf} ${FileExists} "$EXEDIR\allradione-update-stage.json"
    ${GetParameters} $0
    ${GetOptions} "$0" "/ALLRADIONEAPP=" $AllradioneParentPid
    ClearErrors
  ${EndIf}
  Push $0
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    StrCpy $AllradioneHadInstall "1"
  ${EndIf}
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    StrCpy $AllradioneHadInstall "1"
  ${EndIf}
  Pop $0
!macroend

!macro customInstall
  ; Bounded, one-time handoff when Setup was downloaded beside the old portable.
  ; Existing installed preferences and the original portable directory are untouched.
  ${If} $AllradioneHadInstall == "0"
  ${AndIfNot} ${isUpdated}
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    SetShellVarContext current
    StrCpy $0 "$EXEDIR\Allradione-data"
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r4'
    IntOp $4 $4 & 0x400
    ${If} $4 == 0
      StrCpy $0 "$EXEDIR\Allradione-data\settings.json"
      System::Call 'kernel32::GetFileAttributesW(w r0) i.r4'
      IntOp $4 $4 & 0x400
      ${If} $4 == 0
        ClearErrors
        FileOpen $1 "$0" r
        ${IfNot} ${Errors}
          FileSeek $1 0 END $2
          FileClose $1
          ${If} $2 > 0
          ${AndIf} $2 <= 4194304
            StrCpy $3 "$APPDATA\Allradione"
            System::Call 'kernel32::GetFileAttributesW(w r3) i.r4'
            ${If} $4 == -1
              CreateDirectory "$3"
              StrCpy $4 0
            ${Else}
              IntOp $4 $4 & 0x400
            ${EndIf}
            ${If} $4 == 0
              StrCpy $3 "$APPDATA\Allradione\settings.json"
              System::Call 'kernel32::CopyFileW(w r0, w r3, i 1) i.r2'
              ${If} $2 != 0
                FileOpen $1 "$APPDATA\Allradione\allradione-owner.txt" w
                FileWrite $1 "io.github.samueltoken.allradione"
                FileClose $1
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
  ; A stable per-user location is resolved by the actual desktop executable.
  Push $0
  Push $1
  FileOpen $0 "$INSTDIR\allradione-install-owner.txt" w
  FileWrite $0 "io.github.samueltoken.allradione"
  FileClose $0
  WriteRegStr HKCU "Software\Allradione" AppId "io.github.samueltoken.allradione"
  WriteRegStr HKCU "Software\Allradione" InstallLocation "$INSTDIR"
  ${IfNot} ${isNoDesktopShortcut}
    ExecWait '"$INSTDIR\resources\desktop-launcher.exe" --install-desktop --quiet' $1
    ${If} $1 != 0
      DetailPrint "Desktop icon could not be created; existing unrelated files were preserved."
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend
