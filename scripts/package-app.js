import { packager } from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs';

async function bundle() {
  console.log('Packaging lightweight ASAR RIPcheck desktop application for Windows x64...');

  const options = {
    dir: '.',
    out: 'dist-app',
    name: 'RIPcheck',
    executableName: 'RIPcheck',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: {
      unpack: '**/dist/**',
    },
    prune: false,
    appVersion: '1.0.0',
    appCopyright: 'Copyright © 2026 RIPcheck',
    win32metadata: {
      CompanyName: 'RIPcheck',
      FileDescription: 'RIPcheck — Preflight para sublimación',
      OriginalFilename: 'RIPcheck.exe',
      ProductName: 'RIPcheck',
      InternalName: 'RIPcheck',
    },
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.agents($|\/)/,
      /^\/\.codex($|\/)/,
      /^\/\.openai($|\/)/,
      /^\/\.vinext($|\/)/,
      /^\/\.wrangler($|\/)/,
      /^\/tests($|\/)/,
      /^\/examples($|\/)/,
      /^\/release($|\/)/,
      /^\/dist-app($|\/)/,
      /^\/scripts($|\/)/,
      /^\/node_modules\/electron($|\/)/,
      /^\/node_modules\/@electron($|\/)/,
      /^\/node_modules\/electron-builder($|\/)/,
      /^\/node_modules\/electron-winstaller($|\/)/,
      /^\/node_modules\/wrangler($|\/)/,
      /^\/node_modules\/miniflare($|\/)/,
      /^\/node_modules\/@cloudflare($|\/)/,
      /^\/node_modules\/typescript($|\/)/,
      /^\/node_modules\/eslint($|\/)/,
      /^\/node_modules\/drizzle-kit($|\/)/,
      /^\/node_modules\/@types($|\/)/,
      /^\/node_modules\/@next\/swc-darwin/,
      /^\/node_modules\/@next\/swc-linux/,
      /^\/node_modules\/@next\/swc-wasm/,
      /^\/node_modules\/@rolldown\/binding-darwin/,
      /^\/node_modules\/@rolldown\/binding-linux/,
      /^\/node_modules\/@rolldown\/binding-freebsd/,
      /^\/node_modules\/@rolldown\/binding-win32-arm64/,
      /^\/node_modules\/@rolldown\/binding-win32-ia32/,
      /^\/node_modules\/@tailwindcss($|\/)/,
      /^\/node_modules\/tailwindcss($|\/)/,
      /\.map$/,
      /\.md$/,
    ],
  };

  const appPaths = await packager(options);
  console.log(`\nPackaged successfully into:\n${appPaths.join('\n')}\n`);
}

bundle().catch((err) => {
  console.error('Packaging failed:', err);
  process.exit(1);
});
