// PawWork v2 — dsh web 服务生命周期
// 用项目依赖的 dsh 拉起官方 web profile，加上产品 --patch 与自有 DSH_HOME。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  buildDshArgs,
  buildNodeArgs,
  buildLaunchEnv,
  ensureProductHome,
  resolveDshBin,
  resolveProductHome,
} = require('./product-home');

const DEFAULT_PORT = 3080;
const POLL_ATTEMPTS = 60;
const POLL_INTERVAL = 1000;

function getLogDir(home) {
  const dir = path.join(home, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function prepareProductHome(electronApp) {
  const home = resolveProductHome(process.env, electronApp || null);
  ensureProductHome(home);
  return home;
}

function probePort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port) {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  return false;
}

function buildSpawnEnv(home, port) {
  const extraDirs = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ].filter(Boolean);
  const env = buildLaunchEnv(home);
  const PATH = [...new Set([...extraDirs, env.PATH || ''])].filter(Boolean).join(':');
  return { ...env, PATH, PORT: String(port), ELECTRON_RUN_AS_NODE: '1' };
}

function spawnDshServer(port, electronApp) {
  const home = prepareProductHome(electronApp);
  const dshBin = resolveDshBin();
  if (!fs.existsSync(dshBin)) {
    throw new Error(`dsh not found at ${dshBin}. Run pnpm install.`);
  }
  const logDir = getLogDir(home);
  const outFd = fs.openSync(path.join(logDir, 'dsh-web.stdout.log'), 'a');
  const errFd = fs.openSync(path.join(logDir, 'dsh-web.stderr.log'), 'a');
  const args = buildNodeArgs(dshBin, buildDshArgs('web', ['--port', String(port)], home));
  console.log(`[pawwork] spawning dsh home=${home} bin=${dshBin}`);
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: buildSpawnEnv(home, port),
  });
  proc.on('error', (err) => console.error(`[pawwork] failed to start dsh: ${err.message}`));
  try {
    fs.writeFileSync(path.join(logDir, 'dsh-web.pid'), String(proc.pid));
  } catch (_) {}
  proc.unref();
  return proc;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

// 结束本应用拉起的 dsh web（按 pid 文件精确停止，不误杀外部实例）。
async function stopDshServer(_port, electronApp) {
  const home = resolveProductHome(process.env, electronApp || null);
  const logDir = getLogDir(home);
  const pidFile = path.join(logDir, 'dsh-web.pid');
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  } catch (_) {}
  try {
    fs.unlinkSync(pidFile);
  } catch (_) {}
  if (pid && Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
    console.log(`[pawwork] stopping spawned dsh web (pid=${pid}) ...`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_) {}
  }
  return true;
}

module.exports = {
  DEFAULT_PORT,
  POLL_ATTEMPTS,
  POLL_INTERVAL,
  probePort,
  waitForServer,
  spawnDshServer,
  stopDshServer,
  resolveDshBin,
  prepareProductHome,
};
