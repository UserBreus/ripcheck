import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const sourceDir = path.resolve('dist-app', 'RIPcheck-win32-x64');
const outDir = path.resolve('release');
const zipPath = path.resolve(outDir, 'RIPcheck-Windows-x64.zip');

if (!fs.existsSync(sourceDir)) {
  console.error(`Source directory not found: ${sourceDir}`);
  process.exit(1);
}

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

console.log(`Creating ZIP package at: ${zipPath}...`);

// Use Windows native tar.exe (fast zip generation)
execSync(`tar.exe -a -c -f "${zipPath}" -C "dist-app" "RIPcheck-win32-x64"`, { stdio: 'inherit' });

const stats = fs.statSync(zipPath);
const mb = (stats.size / (1024 * 1024)).toFixed(1);
console.log(`\nZIP created successfully! Size: ${mb} MB`);
console.log(`Location: ${zipPath}\n`);
