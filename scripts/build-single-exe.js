import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const projectRoot = path.resolve('.');
const distAppDir = path.resolve(projectRoot, 'dist-app', 'RIPcheck-win32-x64');
const releaseDir = path.resolve(projectRoot, 'release');
const makensisPath = path.resolve(
  process.env.LOCALAPPDATA,
  'electron-builder',
  'cache',
  'nsis',
  'nsis-3.0.4.1',
  'Bin',
  'makensis.exe'
);

if (!fs.existsSync(distAppDir)) {
  console.error(`Dist app directory not found: ${distAppDir}`);
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

if (!fs.existsSync(makensisPath)) {
  console.error(`makensis.exe not found at: ${makensisPath}`);
  process.exit(1);
}

console.log('--- Building Single-File Windows Executables with NSIS ---');

// 1. Generate Installer NSI script
const installerNsiPath = path.resolve(releaseDir, 'installer.nsi');
const installerOut = path.resolve(releaseDir, 'RIPcheck-Instalador.exe');
const installerNsiContent = `
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "RIPcheck"
OutFile "${installerOut}"
InstallDir "$LOCALAPPDATA\\Programs\\RIPcheck"
RequestExecutionLevel user
SetCompressor zlib

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\\RIPcheck.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Ejecutar RIPcheck ahora"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Spanish"

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  SetOverwrite try
  File /r "${distAppDir}\\*.*"

  ; Shortcuts
  CreateShortcut "$DESKTOP\\RIPcheck.lnk" "$INSTDIR\\RIPcheck.exe" "" "$INSTDIR\\RIPcheck.exe" 0
  CreateDirectory "$SMPROGRAMS\\RIPcheck"
  CreateShortcut "$SMPROGRAMS\\RIPcheck\\RIPcheck.lnk" "$INSTDIR\\RIPcheck.exe" "" "$INSTDIR\\RIPcheck.exe" 0
  CreateShortcut "$SMPROGRAMS\\RIPcheck\\Desinstalar RIPcheck.lnk" "$INSTDIR\\Uninstall.exe" "" "$INSTDIR\\Uninstall.exe" 0

  ; Uninstaller
  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  ; Registry for Control Panel
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "DisplayName" "RIPcheck — Preflight para sublimación"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "DisplayIcon" '"$INSTDIR\\RIPcheck.exe",0'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "Publisher" "RIPcheck"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "DisplayVersion" "1.0.0"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\RIPcheck.lnk"
  Delete "$SMPROGRAMS\\RIPcheck\\RIPcheck.lnk"
  Delete "$SMPROGRAMS\\RIPcheck\\Desinstalar RIPcheck.lnk"
  RMDir "$SMPROGRAMS\\RIPcheck"

  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck"
SectionEnd
`;

fs.writeFileSync(installerNsiPath, installerNsiContent, 'utf-8');

console.log('1. Compiling RIPcheck-Instalador.exe...');
execSync(`"${makensisPath}" "${installerNsiPath}"`, { stdio: 'inherit' });

// 2. Generate Portable Single-File NSI script
const portableNsiPath = path.resolve(releaseDir, 'portable.nsi');
const portableOut = path.resolve(releaseDir, 'RIPcheck-Portable.exe');
const portableNsiContent = `
!include "FileFunc.nsh"

Name "RIPcheck Portable"
OutFile "${portableOut}"
RequestExecutionLevel user
SetCompressor zlib
SilentInstall silent

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\\app"
  File /r "${distAppDir}\\*.*"
  ExecWait '"$PLUGINSDIR\\app\\RIPcheck.exe"'
SectionEnd
`;

fs.writeFileSync(portableNsiPath, portableNsiContent, 'utf-8');

console.log('\n2. Compiling RIPcheck-Portable.exe...');
execSync(`"${makensisPath}" "${portableNsiPath}"`, { stdio: 'inherit' });

// Report results
console.log('\n=== BUILD COMPLETE ===');
if (fs.existsSync(installerOut)) {
  const sizeMb = (fs.statSync(installerOut).size / (1024 * 1024)).toFixed(1);
  console.log(`[INSTALLER] ${installerOut} (${sizeMb} MB)`);
}
if (fs.existsSync(portableOut)) {
  const sizeMb = (fs.statSync(portableOut).size / (1024 * 1024)).toFixed(1);
  console.log(`[PORTABLE]  ${portableOut} (${sizeMb} MB)`);
}
console.log('=======================\n');
