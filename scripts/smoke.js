// PawWork v2 — smoke：spawn 产品 dsh web → 加载 UI → 截图 → 清理退出
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_PORT, probePort, spawnDshServer, waitForServer, stopDshServer } = require('./dsh-server');

app.setName('pawwork-v2');
app.setPath('userData', path.join(app.getPath('appData'), 'pawwork-v2'));

const PORT = Number(process.env.DSH_PORT || DEFAULT_PORT);
const OUT = process.env.SMOKE_OUT || path.join(__dirname, '..', 'logs', 'smoke.png');

app.whenReady().then(async () => {
  if (!(await probePort(PORT))) spawnDshServer(PORT, app);
  const ok = await waitForServer(PORT);
  if (!ok) {
    console.error('dsh web did not become ready');
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  await win.loadURL(`http://127.0.0.1:${PORT}`);
  // 等 Web UI 脚本渲染稳定
  await new Promise((r) => setTimeout(r, 10000));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  console.log('smoke screenshot saved:', OUT);

  // 文本化验证：页面 title + body 可见文本（截图之外给机器可断言信号）
  const info = await win.webContents.executeJavaScript(`({
    title: document.title,
    bodyText: (document.body && document.body.innerText || '').trim().slice(0, 200)
  })`);
  console.log('page title:', info.title);
  console.log('body text:', JSON.stringify(info.bodyText));

  await stopDshServer(PORT, app);
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
