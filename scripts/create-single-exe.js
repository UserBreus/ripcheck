import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const projectRoot = path.resolve('.');
const distAppDir = path.resolve(projectRoot, 'dist-app', 'RIPcheck-win32-x64');
const releaseDir = path.resolve(projectRoot, 'release');
const tempZipPath = path.resolve(releaseDir, 'app_payload.zip');
const outputExePath = path.resolve(releaseDir, 'RIPcheck-Instalador.exe');
const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

if (!fs.existsSync(distAppDir)) {
  console.error(`Dist app directory not found: ${distAppDir}`);
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

if (fs.existsSync(tempZipPath)) {
  fs.unlinkSync(tempZipPath);
}

console.log('1. Creating application payload ZIP...');
// Fast zip of dist-app contents using tar.exe
execSync(`tar.exe -a -c -f "${tempZipPath}" -C "${distAppDir}" *`, { stdio: 'inherit' });

console.log('2. Writing native C# installer code...');
const csSourcePath = path.resolve(releaseDir, 'Installer.cs');
const csSourceCode = `using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace RIPcheckInstaller
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string appDir = Path.Combine(localAppData, "Programs", "RIPcheck");
                string exePath = Path.Combine(appDir, "RIPcheck.exe");

                // Extract or update payload
                if (!Directory.Exists(appDir) || !File.Exists(exePath))
                {
                    if (!Directory.Exists(appDir))
                    {
                        Directory.CreateDirectory(appDir);
                    }

                    Assembly assembly = Assembly.GetExecutingAssembly();
                    using (Stream stream = assembly.GetManifestResourceStream("app.zip"))
                    {
                        if (stream == null)
                        {
                            MessageBox.Show("No se encontró el paquete de la aplicación integrado.", "Error RIPcheck", MessageBoxButtons.OK, MessageBoxIcon.Error);
                            return;
                        }

                        using (ZipArchive archive = new ZipArchive(stream))
                        {
                            foreach (ZipArchiveEntry entry in archive.Entries)
                            {
                                string destinationPath = Path.GetFullPath(Path.Combine(appDir, entry.FullName));
                                if (!destinationPath.StartsWith(appDir, StringComparison.OrdinalIgnoreCase))
                                {
                                    continue;
                                }

                                if (string.IsNullOrEmpty(entry.Name))
                                {
                                    Directory.CreateDirectory(destinationPath);
                                }
                                else
                                {
                                    string dir = Path.GetDirectoryName(destinationPath);
                                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                                    {
                                        Directory.CreateDirectory(dir);
                                    }
                                    entry.ExtractToFile(destinationPath, true);
                                }
                            }
                        }
                    }

                    // Create Desktop Shortcut
                    try
                    {
                        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                        CreateShortcut(Path.Combine(desktop, "RIPcheck.lnk"), exePath, appDir);
                    }
                    catch { }

                    // Create Start Menu Shortcut
                    try
                    {
                        string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
                        CreateShortcut(Path.Combine(startMenu, "RIPcheck.lnk"), exePath, appDir);
                    }
                    catch { }
                }

                // Start RIPcheck application
                if (File.Exists(exePath))
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = exePath;
                    psi.WorkingDirectory = appDir;
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                }
                else
                {
                    MessageBox.Show("No se pudo encontrar el ejecutable principal en:\\n" + exePath, "Error RIPcheck", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error durante la inicialización de RIPcheck:\\n" + ex.Message, "Error RIPcheck", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        static void CreateShortcut(string shortcutPath, string targetPath, string workDir)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return;
                dynamic shell = Activator.CreateInstance(t);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetPath;
                shortcut.WorkingDirectory = workDir;
                shortcut.Description = "RIPcheck — Preflight para sublimación";
                shortcut.Save();
            }
            catch { }
        }
    }
}
`;

fs.writeFileSync(csSourcePath, csSourceCode, 'utf-8');

console.log('3. Compiling native Single-File Executable with csc.exe...');
const compileCmd = `"${cscPath}" /target:winexe /optimize+ /platform:x64 /reference:System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll /resource:"${tempZipPath}",app.zip /out:"${outputExePath}" "${csSourcePath}"`;

execSync(compileCmd, { stdio: 'inherit' });

// Clean up temporary files
if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
if (fs.existsSync(csSourcePath)) fs.unlinkSync(csSourcePath);

const stats = fs.statSync(outputExePath);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);

console.log('\n========================================');
console.log('🎉 SINGLE-FILE EXECUTABLE CREATED SUCCESSFULLY!');
console.log(`📁 File: ${outputExePath}`);
console.log(`📦 Size: ${sizeMb} MB`);
console.log('========================================\n');
