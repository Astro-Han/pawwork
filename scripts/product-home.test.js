'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureProductHome,
  buildLaunchEnv,
  buildDshArgs,
  buildNodeArgs,
  resolveProductHome,
  resolveDshBin,
  PRODUCT_PATCH_SOURCE,
  PRODUCT_PATCH_FILENAME,
  IMPORT_V1_PLUGIN_FILENAME,
  IMPORT_V1_CORE_FILENAME,
  IMPORT_V1_SETTINGS_FILENAME,
  AUTOMATIONS_PLUGIN_FILENAME,
  AUTOMATIONS_CORE_FILENAME,
  ZEN_IDENTITY_PRELOAD_HREF,
} = require('./product-home');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-dsh-'));
}

test('creates a product home with the public Zen credential and no settings file', () => {
  const home = tempHome();
  const result = ensureProductHome(home);
  assert.equal(result.home, home);
  assert.equal(result.patch, path.join(home, PRODUCT_PATCH_FILENAME));
  const creds = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  assert.match(creds, /OPENCODE_API_KEY:\s*"public"/);
  const patch = fs.readFileSync(result.patch, 'utf8');
  assert.equal(patch, fs.readFileSync(PRODUCT_PATCH_SOURCE, 'utf8'));
  assert.equal(patch.includes('zen-identity'), false);
  assert.equal(fs.existsSync(path.join(home, 'settings.yaml')), false);
  assert.equal(
    fs.existsSync(path.join(home, 'plugins', 'import-v1', IMPORT_V1_PLUGIN_FILENAME)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(home, 'plugins', 'import-v1', IMPORT_V1_CORE_FILENAME)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(home, 'plugins', 'import-v1', IMPORT_V1_SETTINGS_FILENAME)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(home, 'plugins', 'automations', AUTOMATIONS_PLUGIN_FILENAME)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(home, 'plugins', 'automations', AUTOMATIONS_CORE_FILENAME)),
    true,
  );
});

test('leaves an existing credentials file untouched', () => {
  const home = tempHome();
  const credentialsPath = path.join(home, '.credentials.yaml');
  fs.writeFileSync(credentialsPath, 'OPENCODE_API_KEY: "user-key"\n');
  ensureProductHome(home);
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), 'OPENCODE_API_KEY: "user-key"\n');
});

test('points DSH_HOME at the product home and drops inherited provider keys', () => {
  const home = tempHome();
  const env = buildLaunchEnv(home, {
    PATH: '/usr/bin',
    HOME: '/Users/dev',
    OPENCODE_API_KEY: 'sk-dev',
    OPENCODE_GO_API_KEY: 'sk-go',
    DEEPSEEK_API_KEY: 'sk-ds',
    DEEPSEEK_BASE_URL: 'https://example.invalid',
    PORT: '3999',
  });
  assert.equal(env.DSH_HOME, home);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/dev');
  assert.equal(env.PORT, '3999');
  assert.equal(env.OPENCODE_API_KEY, undefined);
  assert.equal(env.OPENCODE_GO_API_KEY, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.DEEPSEEK_BASE_URL, undefined);
});

test('product patch composes Zen Free as the default model', () => {
  const home = tempHome();
  ensureProductHome(home);
  const dumped = spawnSync(
    process.execPath,
    ['--expose-internals', require.resolve('@deepseek-ai/dsh/lib/bin.js'), ...buildDshArgs('web', ['--dump-config'], home)],
    { encoding: 'utf8', env: buildLaunchEnv(home) },
  );
  assert.equal(dumped.status, 0, dumped.stderr);
  assert.match(dumped.stdout, /id: agent-default-model[\s\S]*provider: opencode[\s\S]*model: big-pickle/);
  assert.match(dumped.stdout, /id: llm-pi-ai[\s\S]*opencode:[\s\S]*apiKeyEnv: OPENCODE_API_KEY/);
  assert.equal(dumped.stdout.includes('id: zen-identity'), false);
  assert.match(
    dumped.stdout,
    /id: import-v1[\s\S]*name: \.\.\/\.\.\/plugins\/import-v1\/index\.mjs/,
  );
  assert.match(
    dumped.stdout,
    /id: pawwork-automations[\s\S]*name: \.\.\/\.\.\/plugins\/automations\/index\.mjs/,
  );
  assert.doesNotMatch(dumped.stdout, /provider: deepseek-official/);
});

test('boots official web with the materialized product patch after launcher flags', () => {
  const home = '/tmp/pawwork-home';
  const patch = path.join(home, PRODUCT_PATCH_FILENAME);
  assert.deepEqual(buildDshArgs('web', [], home), ['web', '--patch', patch]);
  assert.deepEqual(
    buildDshArgs('web', ['--port', '3999'], home),
    ['web', '--patch', patch, '--port', '3999'],
  );
  assert.deepEqual(
    buildDshArgs('headless', ['Reply with exactly: OK'], home),
    ['--profile', 'headless', '--patch', patch, 'Reply with exactly: OK'],
  );
  assert.deepEqual(buildDshArgs('web'), ['web', '--patch', PRODUCT_PATCH_SOURCE]);
});

test('preloads Zen identity before the dsh entry so fetch is wrapped first', () => {
  const dshBin = '/tmp/dsh/lib/bin.js';
  const args = buildNodeArgs(dshBin, ['web', '--port', '3999']);
  const importAt = args.indexOf('--import');
  assert.equal(args[0], '--expose-internals');
  assert.equal(importAt, 1);
  assert.equal(args[2], ZEN_IDENTITY_PRELOAD_HREF);
  assert.equal(args[3], dshBin);
  assert.deepEqual(args.slice(4), ['web', '--port', '3999']);
  assert.ok(importAt < args.indexOf(dshBin));
});

test('resolves the product home from DSH_HOME, then Electron userData, then a local fallback', () => {
  const explicit = resolveProductHome({ DSH_HOME: '/tmp/explicit-dsh' });
  assert.equal(explicit, '/tmp/explicit-dsh');
  const electron = resolveProductHome({}, { getPath: (name) => (name === 'userData' ? '/tmp/electron-app' : '') });
  assert.equal(electron, path.join('/tmp/electron-app', 'dsh'));
  const fallback = resolveProductHome({}, null, '/tmp/repo');
  assert.equal(fallback, path.join('/tmp/repo', '.pawwork-dsh'));
});

test('resolves the vendored dsh entry before any global install', () => {
  const vendored = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  assert.equal(resolveDshBin(), vendored);
  assert.equal(resolveDshBin({ DSH_BIN: '/tmp/custom-dsh' }), '/tmp/custom-dsh');
});
