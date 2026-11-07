; Allradione installation hooks. Keep the appId/productName stable across updates.
; Standard electron-builder NSIS owns installed program files, shortcuts, and registry.
; This hook only removes a positively identified Allradione user-data directory.
; Custom includes precede electron-builder's standard template includes.
!include "LogicLib.nsh"

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
!endif

!macro customInit
  StrCpy $AllradioneHadInstall "0"
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
!macroend
