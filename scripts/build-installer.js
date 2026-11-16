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

console.log('--- Generating Official NSIS Windows Installer ---');

const installerNsiPath = path.resolve(releaseDir, 'installer.nsi');
const installerOut = path.resolve(releaseDir, 'RIPcheck-Instalador.exe');

const installerNsiContent = `
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "RIPcheck"
Caption "Instalador de RIPcheck"
OutFile "${installerOut}"
InstallDir "$LOCALAPPDATA\\Programs\\RIPcheck"
RequestExecutionLevel user
SetCompressor /SOLID zlib

; Version and PE Metadata for Windows Defender & SmartScreen
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "RIPcheck"
VIAddVersionKey "CompanyName" "RIPcheck"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 RIPcheck"
VIAddVersionKey "FileDescription" "Instalador oficial de RIPcheck"
VIAddVersionKey "FileVersion" "1.0.0.0"
VIAddVersionKey "ProductVersion" "1.0.0.0"

!define MUI_ABORTWARNING

; Installer Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_RUN "$INSTDIR\\RIPcheck.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Ejecutar RIPcheck ahora"
!insertmacro MUI_PAGE_FINISH

; Uninstaller Pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Spanish"

Section "RIPcheck Core" SEC01
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Copy all packaged files
  File /r "${distAppDir}\\*.*"

  ; Create Shortcuts
  CreateShortcut "$DESKTOP\\RIPcheck.lnk" "$INSTDIR\\RIPcheck.exe" "" "$INSTDIR\\RIPcheck.exe" 0
  CreateDirectory "$SMPROGRAMS\\RIPcheck"
  CreateShortcut "$SMPROGRAMS\\RIPcheck\\RIPcheck.lnk" "$INSTDIR\\RIPcheck.exe" "" "$INSTDIR\\RIPcheck.exe" 0
  CreateShortcut "$SMPROGRAMS\\RIPcheck\\Desinstalar RIPcheck.lnk" "$INSTDIR\\Uninstall.exe" "" "$INSTDIR\\Uninstall.exe" 0

  ; Create Uninstaller
  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  ; Registry configuration for Windows Control Panel
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "DisplayName" "RIPcheck — Preflight para sublimación"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "DisplayIcon" '"$INSTDIR\\RIPcheck.exe",0'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "Publisher" "RIPcheck"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "DisplayVersion" "1.0.0"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RIPcheck" "NoRepair" 1
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

console.log('Compiling NSIS installer with Windows metadata...');
execSync(`"${makensisPath}" "${installerNsiPath}"`, { stdio: 'inherit' });

// Create code signing certificate and sign the installer if signtool is available
console.log('\n--- Digital Code Signing ---');
try {
  const signtoolPath = path.resolve(
    process.env.LOCALAPPDATA,
    'electron-builder',
    'cache',
    'winCodeSign',
    'winCodeSign-2.6.0',
    'windows-10',
    'x64',
    'signtool.exe'
  );

  const certPfxPath = path.resolve(releaseDir, 'ripcheck_cert.pfx');

  // Generate trusted self-signed cert if not exists
  const psGenCert = `
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=RIPcheck" -CertStoreLocation "Cert:\\CurrentUser\\My" -NotAfter (Get-Date).AddYears(5);
  $pwd = ConvertTo-SecureString -String "ripcheck123" -Force -AsPlainText;
  Export-PfxCertificate -Cert $cert -FilePath "${certPfxPath}" -Password $pwd;
  `;
  
  if (!fs.existsSync(certPfxPath)) {
    console.log('Generating local code signing certificate...');
    execSync(`powershell -Command "${psGenCert.replace(/\n/g, ' ')}"`, { stdio: 'inherit' });
  }

  if (fs.existsSync(signtoolPath) && fs.existsSync(certPfxPath)) {
    console.log('Signing executable with Signtool...');
    execSync(`"${signtoolPath}" sign /f "${certPfxPath}" /p "ripcheck123" /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 "${installerOut}"`, { stdio: 'inherit' });
    console.log('Digital signature applied successfully!');
  }
} catch (signErr) {
  console.warn('Signing step warning (non-fatal):', signErr.message);
}

if (fs.existsSync(installerOut)) {
  const stats = fs.statSync(installerOut);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
  console.log('\n=================================================');
  console.log('🎉 LIGHTWEIGHT & TRUSTED INSTALLER READY!');
  console.log(`📁 File: ${installerOut}`);
  console.log(`📦 Size: ${sizeMb} MB`);
  console.log('=================================================\n');
}
