'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createDshSettingImporter,
  readV1Preferences,
  runV1SettingsImport,
} = require('./import-v1-settings.cjs');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-import-v1-settings-'));
}

function createPreferenceFixture(root) {
  fs.mkdirSync(path.join(root, 'data', 'pawwork'), { recursive: true });
  fs.writeFileSync(path.join(root, 'default.dat'), JSON.stringify({
    settings: {
      v3: JSON.stringify({
        general: { followup: 'steer', autoSave: false, lspEnabled: true },
        updates: { startup: false },
        appearance: { fontSize: 16 },
        keybinds: { 'settings.open': 'mod+/' },
        notify: 'always',
      }),
    },
  }));
  fs.writeFileSync(path.join(root, 'pawwork.global.dat'), JSON.stringify({
    language: JSON.stringify({ locale: 'en' }),
    model: JSON.stringify({
      recent: [
        { providerID: 'unavailable', modelID: 'old-model' },
        { providerID: 'opencode', modelID: 'deepseek-v4-flash-free' },
      ],
      user: [{ providerID: 'opencode', modelID: 'hidden-model', visibility: 'hide' }],
      variant: { 'opencode/deepseek-v4-flash-free': 'high' },
    }),
    permission: JSON.stringify({ autoAccept: { session: true } }),
  }));
  fs.writeFileSync(path.join(root, 'data', 'pawwork', 'auth.json'), JSON.stringify({
    openai: { type: 'oauth', access: 'secret' },
    'kimi-for-coding': { type: 'api', key: 'secret' },
  }));
}

test('reads only settings with exact DSH equivalents and ignores credentials', () => {
  const root = temporaryDirectory();
  createPreferenceFixture(root);

  const preferences = readV1Preferences(root);

  assert.deepEqual(preferences.settings, [
    { id: 'locale', kind: 'field', namespace: 'locale', field: 'preference', value: 'en' },
    { id: 'busy-enter', kind: 'field', namespace: 'ui-conversation', field: 'busyEnter', value: 'queue' },
    {
      id: 'default-model',
      kind: 'model',
      candidates: [
        { provider: 'unavailable', model: 'old-model' },
        { provider: 'opencode', model: 'deepseek-v4-flash-free' },
      ],
    },
  ]);
  assert.equal(Object.hasOwn(preferences, 'credentials'), false);
  assert.ok(preferences.unsupportedSettings.includes('appearance.fontSize'));
  assert.ok(preferences.unsupportedSettings.includes('general.autoSave'));
  assert.ok(preferences.unsupportedSettings.includes('model.variant'));
  assert.ok(preferences.unsupportedSettings.includes('permission'));
  assert.equal(JSON.stringify(preferences).includes('secret'), false);
});

test('reconciles settings against DSH and records only failures', async () => {
  const root = temporaryDirectory();
  const appData = path.join(root, 'v1');
  const home = path.join(root, 'v2');
  createPreferenceFixture(appData);
  const sourceFiles = [
    path.join(appData, 'default.dat'),
    path.join(appData, 'pawwork.global.dat'),
    path.join(appData, 'data', 'pawwork', 'auth.json'),
  ];
  const sourceBefore = sourceFiles.map((file) => fs.readFileSync(file));
  const firstCalls = [];

  await runV1SettingsImport({
    home,
    sourceAppData: appData,
    importSetting: async (setting) => {
      firstCalls.push(setting.id);
      if (setting.id === 'busy-enter') throw new Error('simulated interruption');
      return setting.id === 'default-model' ? 'unsupported' : 'imported';
    },
  });
  const afterFailure = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(afterFailure.settings, undefined);
  assert.match(afterFailure.failures.settings['busy-enter'].message, /simulated interruption/);

  const resumedCalls = [];
  await runV1SettingsImport({
    home,
    sourceAppData: appData,
    importSetting: async (setting) => {
      resumedCalls.push(setting.id);
      return 'skipped';
    },
  });
  assert.deepEqual(resumedCalls, firstCalls);
  const reconciled = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(reconciled.failures.settings['busy-enter'], undefined);
  assert.deepEqual(sourceFiles.map((file) => fs.readFileSync(file)), sourceBefore);
});

test('does not commit a setting after cancellation during import', async () => {
  const root = temporaryDirectory();
  const appData = path.join(root, 'v1');
  const home = path.join(root, 'v2');
  createPreferenceFixture(appData);
  const controller = new AbortController();
  let abortedSetting;

  await assert.rejects(runV1SettingsImport({
    home,
    sourceAppData: appData,
    signal: controller.signal,
    importSetting: async (setting) => {
      abortedSetting = setting.id;
      controller.abort(new Error('settings import stopped'));
      return 'imported';
    },
  }), /settings import stopped/);

  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.failures.settings[abortedSetting], undefined);
});

test('preserves v2 overrides and imports the first model currently advertised by DSH', async () => {
  const updates = [];
  const selections = [];
  const descriptors = [
    {
      ns: 'locale',
      revision: 4,
      value: { preference: 'zh' },
      user: { preference: 'zh' },
    },
    {
      ns: 'ui-conversation',
      revision: 7,
      value: { busyEnter: 'steer' },
    },
    {
      ns: 'agent-default-model',
      revision: 9,
      value: { provider: 'opencode', model: 'big-pickle' },
    },
  ];
  const importSetting = createDshSettingImporter({
    settings: {
      describe: () => descriptors,
      update: async (namespace, patch, revision) => updates.push({ namespace, patch, revision }),
      replace: async (namespace, value, revision) => selections.push({ namespace, value, revision }),
    },
    llm: {
      listProviders: () => [{ id: 'opencode', name: 'OpenCode Zen' }],
      listModels: async () => [{ provider: 'opencode', id: 'deepseek-v4-flash-free', name: 'DeepSeek V4' }],
    },
  });

  assert.equal(await importSetting({
    id: 'locale', kind: 'field', namespace: 'locale', field: 'preference', value: 'en',
  }), 'skipped');
  assert.equal(await importSetting({
    id: 'busy-enter', kind: 'field', namespace: 'ui-conversation', field: 'busyEnter', value: 'queue',
  }), 'imported');
  assert.equal(await importSetting({
    id: 'default-model',
    kind: 'model',
    candidates: [
      { provider: 'missing', model: 'old-model' },
      { provider: 'opencode', model: 'deepseek-v4-flash-free' },
    ],
  }), 'imported');

  assert.deepEqual(updates, [{
    namespace: 'ui-conversation', patch: { busyEnter: 'queue' }, revision: 7,
  }]);
  assert.deepEqual(selections, [{
    namespace: 'agent-default-model',
    value: { provider: 'opencode', model: 'deepseek-v4-flash-free' },
    revision: 9,
  }]);
});

test('skips an overridden model and rejects settings without a live equivalent', async () => {
  const importSetting = createDshSettingImporter({
    settings: {
      describe: () => [{
        ns: 'agent-default-model',
        revision: 3,
        value: { provider: 'opencode', model: 'big-pickle' },
        user: { provider: 'opencode' },
      }],
      update: async () => assert.fail('unsupported or overridden settings must not be written'),
      replace: async () => assert.fail('unsupported or overridden settings must not be written'),
    },
    llm: {
      listProviders: () => [{ id: 'opencode', name: 'OpenCode Zen' }],
      listModels: async () => [],
    },
  });

  assert.equal(await importSetting({
    id: 'default-model', kind: 'model', candidates: [{ provider: 'opencode', model: 'missing' }],
  }), 'skipped');
  assert.equal(await importSetting({
    id: 'unknown', kind: 'field', namespace: 'missing', field: 'value', value: true,
  }), 'unsupported');
});

test('keeps model migration retryable when the matching provider catalog is unavailable', async () => {
  const importSetting = createDshSettingImporter({
    settings: {
      describe: () => [{
        ns: 'agent-default-model',
        revision: 3,
        value: { provider: 'opencode', model: 'big-pickle' },
      }],
      update: async () => assert.fail('unavailable models must not update settings'),
      replace: async () => assert.fail('unavailable models must not replace settings'),
    },
    llm: {
      listProviders: () => [{ id: 'opencode', name: 'OpenCode Zen' }],
      listModels: async () => { throw new Error('temporary catalog failure'); },
    },
  });

  await assert.rejects(
    importSetting({
      id: 'default-model',
      kind: 'model',
      candidates: [{ provider: 'opencode', model: 'deepseek-v4-flash-free' }],
    }),
    /temporary catalog failure/,
  );
});
