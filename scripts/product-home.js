'use strict';
const fs = require('fs');
const path = require('path');

const PUBLIC_CREDENTIAL = 'OPENCODE_API_KEY: "public"\n';
const PRODUCT_PATCH_SOURCE = path.join(__dirname, '..', 'config', 'product.cordis.patch.yml');
const ZEN_IDENTITY_PRELOAD = path.join(__dirname, 'zen-identity-preload.mjs');
const ZEN_IDENTITY_PRELOAD_HREF = require('url').pathToFileURL(ZEN_IDENTITY_PRELOAD).href;
const PRODUCT_PATCH_FILENAME = 'product.cordis.patch.yml';
const IMPORT_V1_PLUGIN_FILENAME = 'index.mjs';
const IMPORT_V1_CORE_FILENAME = 'import-v1.cjs';
const IMPORT_V1_SETTINGS_FILENAME = 'import-v1-settings.cjs';
const IMPORT_V1_SOURCE = path.join(__dirname, 'import-v1-plugin.mjs');
const IMPORT_V1_CORE_SOURCE = path.join(__dirname, 'import-v1.js');
const IMPORT_V1_SETTINGS_SOURCE = path.join(__dirname, 'import-v1-settings.js');

function importV1PluginDirectory(home) {
  return path.join(home, 'plugins', 'import-v1');
}

function writeImportV1Plugin(home) {
  const directory = importV1PluginDirectory(home);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(IMPORT_V1_SOURCE, path.join(directory, IMPORT_V1_PLUGIN_FILENAME));
  fs.copyFileSync(IMPORT_V1_CORE_SOURCE, path.join(directory, IMPORT_V1_CORE_FILENAME));
  fs.copyFileSync(IMPORT_V1_SETTINGS_SOURCE, path.join(directory, IMPORT_V1_SETTINGS_FILENAME));
}

const DROPPED_ENV = [
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
];

function writeProductPatch(home) {
  const dest = path.join(home, PRODUCT_PATCH_FILENAME);
  fs.copyFileSync(PRODUCT_PATCH_SOURCE, dest);
  return dest;
}

function ensureProductHome(home) {
  fs.mkdirSync(home, { recursive: true });
  const credentialsPath = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(credentialsPath)) {
    fs.writeFileSync(credentialsPath, PUBLIC_CREDENTIAL, { mode: 0o600 });
  }
  writeImportV1Plugin(home);
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

function buildNodeArgs(dshBin, dshArgs = []) {
  return ['--expose-internals', '--import', ZEN_IDENTITY_PRELOAD_HREF, dshBin, ...dshArgs];
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
  IMPORT_V1_PLUGIN_FILENAME,
  IMPORT_V1_CORE_FILENAME,
  IMPORT_V1_SETTINGS_FILENAME,
  ZEN_IDENTITY_PRELOAD,
  ZEN_IDENTITY_PRELOAD_HREF,
  ensureProductHome,
  buildLaunchEnv,
  buildDshArgs,
  buildNodeArgs,
  resolveProductHome,
  resolveDshBin,
};
