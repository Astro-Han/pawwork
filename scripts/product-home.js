'use strict';
const fs = require('fs');
const path = require('path');

const PUBLIC_CREDENTIAL = 'OPENCODE_API_KEY: "public"\n';
const PRODUCT_PATCH_SOURCE = path.join(__dirname, '..', 'config', 'product.cordis.patch.yml');
const ZEN_IDENTITY = path.join(__dirname, 'zen-identity.mjs');
const ZEN_IDENTITY_HREF = require('url').pathToFileURL(ZEN_IDENTITY).href;
const PRODUCT_PATCH_FILENAME = 'product.cordis.patch.yml';

const DROPPED_ENV = [
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
];

function writeProductPatch(home) {
  const dest = path.join(home, PRODUCT_PATCH_FILENAME);
  const source = fs.readFileSync(PRODUCT_PATCH_SOURCE, 'utf8');
  fs.writeFileSync(dest, source.replaceAll('__ZEN_IDENTITY__', ZEN_IDENTITY_HREF));
  return dest;
}

function ensureProductHome(home) {
  fs.mkdirSync(home, { recursive: true });
  const credentialsPath = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(credentialsPath)) {
    fs.writeFileSync(credentialsPath, PUBLIC_CREDENTIAL, { mode: 0o600 });
  }
  return { home, patch: writeProductPatch(home) };
}

function buildLaunchEnv(home, source = process.env) {
  const env = { ...source, DSH_HOME: home };
  for (const name of DROPPED_ENV) delete env[name];
  return env;
}

function buildDshArgs(command, appArgs = [], home = null) {
  const launcher = command === 'web' ? ['web'] : ['--profile', command];
  const patch = home ? path.join(home, PRODUCT_PATCH_FILENAME) : PRODUCT_PATCH_SOURCE;
  return [...launcher, '--patch', patch, ...appArgs];
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
  PRODUCT_PATCH: PRODUCT_PATCH_SOURCE,
  PRODUCT_PATCH_SOURCE,
  PRODUCT_PATCH_FILENAME,
  ZEN_IDENTITY,
  ZEN_IDENTITY_HREF,
  ensureProductHome,
  buildLaunchEnv,
  buildDshArgs,
  resolveProductHome,
  resolveDshBin,
};
