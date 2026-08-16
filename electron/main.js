// PawWork v2 — Electron 主进程
// 拉起官方 dsh web + 产品 patch，探测就绪后加载 Web UI；退出时按 pid 停本实例。
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

app.setName('pawwork-v2');
app.setPath('userData', path.join(app.getPath('appData'), 'pawwork-v2'));

const PORT = Number(process.env.DSH_PORT || DEFAULT_PORT);
const APP_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;

async function ensureDshServer() {
  if (await probePort(PORT)) return true;
  console.log(`[pawwork] port :${PORT} idle, spawning dsh web ...`);
  try {
    spawnDshServer(PORT, app);
  } catch (err) {
    console.error(`[pawwork] failed to spawn dsh: ${err.message}`);
    app.exit(1);
    return false;
  }
  const ok = await waitForServer(PORT);
  if (!ok) {
    console.error(`[pawwork] dsh web did not become ready on :${PORT}`);
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
    stopDshServer(PORT, app)
      .catch(() => {})
      .finally(() => app.quit());
  }
});
