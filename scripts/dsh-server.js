// PawWork v2 — dsh web 服务生命周期
// M0：定位 dsh 可执行文件（DSH_BIN → PATH → npx 缓存），用 process.execPath（Electron 内置 Node）
// 拉起 `dsh web`，HTTP 探测端口就绪，退出时按 pid 文件精确停止本应用拉起的实例。
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 3080;
const POLL_ATTEMPTS = 60; // 最多等 60 秒
const POLL_INTERVAL = 1000; // 每秒探测一次

// 日志目录：优先 DSH_DATA_DIR，否则工程根 logs/（M0 开发模式）
function getDataDir() {
  const base = process.env.DSH_DATA_DIR || process.cwd();
  const dir = path.join(base, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

// 定位 dsh 可执行文件；找不到返回 null（M0 不做自动安装，报错引导手动安装）。
function resolveDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  const which = spawnSync('sh', ['-lc', 'command -v dsh'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  try {
    if (fs.existsSync(npxRoot)) {
      const candidates = fs
        .readdirSync(npxRoot)
        .map((d) => path.join(npxRoot, d, 'node_modules', '.bin', 'dsh'))
        .filter((p) => fs.existsSync(p))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    }
  } catch (_) {}
  return null;
}

// 构造 spawn 环境：把常见 bin 目录注入 PATH，供 dsh 内部子进程使用。
// ELECTRON_RUN_AS_NODE=1：开发/打包下 process.execPath 是 Electron 二进制，
// 必须以此变量让它在纯 Node 模式下运行 dsh。
function buildSpawnEnv(port) {
  const extraDirs = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ].filter(Boolean);
  const PATH = [...new Set([...extraDirs, process.env.PATH || ''])].filter(Boolean).join(':');
  return { ...process.env, PATH, PORT: String(port), ELECTRON_RUN_AS_NODE: '1' };
}

// 拉起常驻 dsh web（detached + unref）。核心：用 process.execPath（Electron 内置 Node）执行 dsh，
// 不依赖系统 PATH 中的 node，也不依赖 dsh 的 shebang。
// --expose-internals 是 dsh HMR 插件（cordis-plugin-hmr）的要求。
function spawnDshServer(port) {
  const dshBin = resolveDshBin();
  if (!dshBin) {
    throw new Error('dsh not found. Install with: npm i -g @deepseek-ai/dsh (or set DSH_BIN)');
  }
  const logDir = getDataDir();
  const outFd = fs.openSync(path.join(logDir, 'dsh-web.stdout.log'), 'a');
  const errFd = fs.openSync(path.join(logDir, 'dsh-web.stderr.log'), 'a');
  console.log(`[pawwork] spawning dsh via process.execPath: ${dshBin}`);
  const proc = spawn(process.execPath, ['--expose-internals', dshBin, 'web'], {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: buildSpawnEnv(port),
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
async function stopDshServer(_port) {
  const logDir = getDataDir();
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
};
