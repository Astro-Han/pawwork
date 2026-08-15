// PawWork v2 — Electron 主进程
// M0：拉起本地 dsh web（官方 profile），探测就绪后加载 Web UI；退出时精确结束本应用拉起的实例。
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const {
  DEFAULT_PORT,
  probePort,
  waitForServer,
  spawnDshServer,
  stopDshServer,
} = require('../scripts/dsh-server');

const PORT = Number(process.env.DSH_PORT || DEFAULT_PORT);
const APP_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;

async function ensureDshServer() {
  if (await probePort(PORT)) return true;
  console.log(`[pawwork] port :${PORT} idle, spawning dsh web ...`);
  try {
    spawnDshServer(PORT);
  } catch (err) {
    console.error(`[pawwork] failed to spawn dsh: ${err.message}`);
    app.exit(1);
    return false;
  }
  const ok = await waitForServer(PORT);
  if (!ok) {
    console.error(`[pawwork] dsh web did not become ready on :${PORT} (see logs/dsh-web.stderr.log)`);
    app.exit(1);
    return false;
  }
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'PawWork v2',
    backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(APP_URL);

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await ensureDshServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  if (!app._dshStopping) {
    app._dshStopping = true;
    e.preventDefault();
    stopDshServer(PORT)
      .catch(() => {})
      .finally(() => app.quit());
  }
});
