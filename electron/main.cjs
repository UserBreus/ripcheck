const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let serverInstance = null;

async function startServer() {
  const possiblePaths = [
    path.join(__dirname, '..', 'dist'),
    path.join(process.resourcesPath, 'app', 'dist'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist'),
    path.resolve(__dirname, '..', 'dist'),
  ];

  let outDir = possiblePaths.find((p) => fs.existsSync(p)) || path.join(__dirname, '..', 'dist');
  console.log('[Electron] Using outDir:', outDir);

  try {
    const { startProdServer } = await import('vinext/server/prod-server');
    const res = await startProdServer({
      port: 0,
      host: '127.0.0.1',
      outDir: outDir,
    });
    serverInstance = res.server;
    console.log('[Electron] Server started on port:', res.port);
    return res.port;
  } catch (err) {
    console.error('[Electron] Failed to start vinext prod server:', err);
    throw err;
  }
}

async function createWindow() {
  let port;
  try {
    port = await startServer();
  } catch (e) {
    dialog.showErrorBox('Error al iniciar el servidor', e.message || String(e));
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 960,
    minHeight: 640,
    title: 'RIPcheck — Preflight para sublimación',
    autoHideMenuBar: true,
    show: false, // Don't show until ready
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const url = `http://127.0.0.1:${port}/`;
  console.log('[Electron] Loading URL:', url);

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] did-finish-load');
    mainWindow.show();
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[Electron] did-fail-load:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] ${message} (${sourceId}:${line})`);
  });

  try {
    await mainWindow.loadURL(url);
  } catch (err) {
    console.error('[Electron] loadURL error:', err);
    mainWindow.show();
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (serverInstance) {
      try {
        serverInstance.close();
      } catch (e) {}
    }
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
