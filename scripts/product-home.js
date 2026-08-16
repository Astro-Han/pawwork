'use strict';
const fs = require('fs');
const path = require('path');

const PUBLIC_CREDENTIAL = 'OPENCODE_API_KEY: "public"\n';
const PRODUCT_PATCH = path.join(__dirname, '..', 'config', 'product.cordis.patch.yml');

const DROPPED_ENV = [
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
];

function ensureProductHome(home) {
  fs.mkdirSync(home, { recursive: true });
  const credentialsPath = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(credentialsPath)) {
    fs.writeFileSync(credentialsPath, PUBLIC_CREDENTIAL, { mode: 0o600 });
  }
  return { home };
}

function buildLaunchEnv(home, source = process.env) {
  const env = { ...source, DSH_HOME: home };
  for (const name of DROPPED_ENV) delete env[name];
  return env;
}

function buildDshArgs(command, appArgs = []) {
  const launcher = command === 'web' ? ['web'] : ['--profile', command];
  return [...launcher, '--patch', PRODUCT_PATCH, ...appArgs];
}

function resolveProductHome(source = process.env, electronApp = null, repoRoot = path.join(__dirname, '..')) {
  if (source.DSH_HOME) return source.DSH_HOME;
  if (electronApp && typeof electronApp.getPath === 'function') {
    return path.join(electronApp.getPath('userData'), 'dsh');
  }
  return path.join(repoRoot, '.pawwork-dsh');
}

function resolveDshBin(source = process.env, repoRoot = path.join(__dirname, '..')) {
  if (source.DSH_BIN) return source.DSH_BIN;
  return path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

module.exports = {
  PRODUCT_PATCH,
  ensureProductHome,
  buildLaunchEnv,
  buildDshArgs,
  resolveProductHome,
  resolveDshBin,
};
