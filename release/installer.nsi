
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "RIPcheck"
Caption "Instalador de RIPcheck"
OutFile "C:\Users\user2\Documents\tincho\codigos\RIP\release\RIPcheck-Instalador.exe"
InstallDir "$LOCALAPPDATA\Programs\RIPcheck"
RequestExecutionLevel user
SetCompressor /SOLID zlib

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "RIPcheck"
VIAddVersionKey "CompanyName" "RIPcheck"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 RIPcheck"
VIAddVersionKey "FileDescription" "Instalador oficial de RIPcheck"
VIAddVersionKey "FileVersion" "1.0.0.0"
VIAddVersionKey "ProductVersion" "1.0.0.0"

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_RUN "$INSTDIR\RIPcheck.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Ejecutar RIPcheck ahora"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Spanish"

Section "RIPcheck Core" SEC01
  SetOutPath "$INSTDIR"
  SetOverwrite on

  File /r "C:\Users\user2\Documents\tincho\codigos\RIP\dist-app-final\RIPcheck-win32-x64\*.*"

  CreateShortcut "$DESKTOP\RIPcheck.lnk" "$INSTDIR\RIPcheck.exe" "" "$INSTDIR\RIPcheck.exe" 0
  CreateDirectory "$SMPROGRAMS\RIPcheck"
  CreateShortcut "$SMPROGRAMS\RIPcheck\RIPcheck.lnk" "$INSTDIR\RIPcheck.exe" "" "$INSTDIR\RIPcheck.exe" 0
  CreateShortcut "$SMPROGRAMS\RIPcheck\Desinstalar RIPcheck.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RIPcheck" "DisplayName" "RIPcheck — Preflight para sublimación"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RIPcheck" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RIPcheck" "DisplayIcon" '"$INSTDIR\RIPcheck.exe",0'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RIPcheck" "Publisher" "RIPcheck"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RIPcheck" "DisplayVersion" "1.0.0"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RIPcheck" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RIPcheck" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\RIPcheck.lnk"
  Delete "$SMPROGRAMS\RIPcheck\RIPcheck.lnk"
  Delete "$SMPROGRAMS\RIPcheck\Desinstalar RIPcheck.lnk"
  RMDir "$SMPROGRAMS\RIPcheck"

  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RIPcheck"
SectionEnd
