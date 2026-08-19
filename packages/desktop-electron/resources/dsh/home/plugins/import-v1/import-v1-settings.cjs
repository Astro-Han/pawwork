'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, readMigrationLedger, writeJsonAtomically } = require('./migration-io.cjs');

const V1_APP_ID = 'ai.pawwork.desktop';

function v1AppDataCandidates({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  pathApi = platform === 'win32' ? path.win32 : path,
} = {}) {
  if (platform === 'darwin') {
    return [pathApi.join(home, 'Library', 'Application Support', V1_APP_ID)];
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || pathApi.join(home, 'AppData', 'Roaming');
    return [pathApi.join(appData, V1_APP_ID)];
  }
  return [];
}

function discoverV1AppData(options = {}) {
  const env = options.env || process.env;
  const explicit = env.PAWWORK_V1_APP_DATA;
  if (explicit && fs.existsSync(explicit)) return explicit;
  return v1AppDataCandidates(options).find((candidate) => fs.existsSync(candidate)) || null;
}

function storedJson(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${error.message}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function leafPaths(value, prefix = '', result = []) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    if (prefix) result.push(prefix);
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    leafPaths(child, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
}

function readV1Preferences(appData) {
  const defaults = readJson(path.join(appData, 'default.dat'), {});
  const globals = readJson(path.join(appData, 'pawwork.global.dat'), {});
  const settingsV3 = storedJson(defaults.settings?.v3, 'default.dat settings.v3', {});
  const language = storedJson(globals.language, 'pawwork.global.dat language', {});
  const model = storedJson(globals.model, 'pawwork.global.dat model', {});
  const permission = storedJson(globals.permission, 'pawwork.global.dat permission', undefined);
  const settings = [];
  const migratedPaths = new Set();

  if (language?.locale === 'zh' || language?.locale === 'en') {
    settings.push({
      id: 'locale',
      kind: 'field',
      namespace: 'locale',
      field: 'preference',
      value: language.locale,
    });
  }

  if (settingsV3?.general?.followup === 'queue' || settingsV3?.general?.followup === 'steer') {
    settings.push({
      id: 'busy-enter',
      kind: 'field',
      namespace: 'ui-conversation',
      field: 'busyEnter',
      value: 'queue',
    });
    migratedPaths.add('general.followup');
  }

  const candidates = Array.isArray(model?.recent)
    ? model.recent.flatMap((entry) => (
      typeof entry?.providerID === 'string' && typeof entry?.modelID === 'string'
        ? [{ provider: entry.providerID, model: entry.modelID }]
        : []
    ))
    : [];
  if (candidates.length > 0) settings.push({ id: 'default-model', kind: 'model', candidates });

  const unsupportedSettings = leafPaths(settingsV3)
    .filter((entry) => !migratedPaths.has(entry));
  if (language?.locale !== undefined && language.locale !== 'zh' && language.locale !== 'en') {
    unsupportedSettings.push('language.locale');
  }
  if (model?.recent !== undefined && candidates.length === 0) unsupportedSettings.push('model.recent');
  if (Array.isArray(model?.user) && model.user.length > 0) unsupportedSettings.push('model.user');
  if (isRecord(model?.variant) && Object.keys(model.variant).length > 0) {
    unsupportedSettings.push('model.variant');
  }
  if (permission !== undefined) unsupportedSettings.push('permission');

  return {
    settings,
    unsupportedSettings: [...new Set(unsupportedSettings)].sort(),
  };
}

function emptyCounts() {
  return { imported: 0, skipped: 0, unsupported: 0, failed: 0 };
}

function emptyResult(sourceAppData, status) {
  return {
    schema: 1,
    sourceAppData,
    status,
    settings: emptyCounts(),
    errors: [],
  };
}

function countCompleted(result, record) {
  if (record.outcome === 'unsupported') result.settings.unsupported += 1;
  else result.settings.skipped += 1;
}

function owns(object, field) {
  return isRecord(object) && Object.prototype.hasOwnProperty.call(object, field);
}

function createDshSettingImporter({ settings, llm }) {
  return async (setting) => {
    const descriptors = settings.describe();
    if (setting.kind === 'field') {
      const descriptor = descriptors.find((entry) => entry.ns === setting.namespace);
      if (!descriptor) return 'unsupported';
      if (!Number.isSafeInteger(descriptor.revision)) throw new Error('DSH setting revision is unavailable');
      if (owns(descriptor.user, setting.field)) return 'skipped';
      if (isRecord(descriptor.value) && descriptor.value[setting.field] === setting.value) return 'skipped';
      await settings.update(setting.namespace, { [setting.field]: setting.value }, descriptor.revision);
      return 'imported';
    }

    if (setting.kind !== 'model') return 'unsupported';
    const descriptor = descriptors.find((entry) => entry.ns === 'agent-default-model');
    if (!descriptor) return 'unsupported';
    if (!Number.isSafeInteger(descriptor.revision)) throw new Error('DSH setting revision is unavailable');
    if (owns(descriptor.user, 'provider') || owns(descriptor.user, 'model')) return 'skipped';

    const providers = new Set(llm.listProviders().map((provider) => provider.id));
    let selected;
    for (const candidate of setting.candidates) {
      if (!providers.has(candidate.provider)) continue;
      let models;
      try {
        models = await llm.listModels(candidate.provider);
      } catch {
        continue;
      }
      if (models.some((model) => model.id === candidate.model)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) return 'unsupported';
    const current = descriptor.value;
    if (current.provider === selected.provider && current.model === selected.model) return 'skipped';
    await settings.replace('agent-default-model', selected, descriptor.revision);
    return 'imported';
  };
}

async function runV1SettingsImport({
  home,
  sourceAppData = discoverV1AppData(),
  importSetting,
  signal,
}) {
  if (!home || !path.isAbsolute(home)) throw new Error('v1 import home must be absolute');
  if (typeof importSetting !== 'function') throw new Error('v1 importSetting adapter is required');
  const directory = path.join(home, 'import-v1');
  const ledgerPath = path.join(directory, 'ledger.json');
  fs.rmSync(path.join(directory, 'settings-result.json'), { force: true });
  const ledger = readMigrationLedger(ledgerPath, {
    schema: 1,
    sourceAppData,
    settings: {},
  });
  ledger.settings ||= {};
  if (ledger.sourceAppData && sourceAppData && ledger.sourceAppData !== sourceAppData) {
    throw new Error(`v1 settings source changed from ${ledger.sourceAppData} to ${sourceAppData}`);
  }
  if (!sourceAppData) {
    const result = emptyResult(null, 'not-found');
    ledger.sourceAppData = null;
    writeJsonAtomically(ledgerPath, ledger);
    return result;
  }

  const preferences = readV1Preferences(sourceAppData);
  const result = emptyResult(sourceAppData, 'complete');
  ledger.sourceAppData = sourceAppData;

  for (const unsupported of preferences.unsupportedSettings) {
    const id = `unsupported:${unsupported}`;
    ledger.settings[id] = { status: 'complete', outcome: 'unsupported', source: unsupported };
    result.settings.unsupported += 1;
  }
  writeJsonAtomically(ledgerPath, ledger);

  for (const setting of preferences.settings) {
    signal?.throwIfAborted();
    const prior = ledger.settings[setting.id];
    if (prior?.status === 'complete') {
      countCompleted(result, prior);
      continue;
    }
    try {
      const outcome = await importSetting(setting);
      if (!['imported', 'skipped', 'unsupported'].includes(outcome)) {
        throw new Error(`invalid v1 setting import outcome: ${outcome}`);
      }
      result.settings[outcome] += 1;
      ledger.settings[setting.id] = { status: 'complete', outcome };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.settings.failed += 1;
      result.errors.push({ setting: setting.id, message });
      ledger.settings[setting.id] = { status: 'failed', message };
    }
    writeJsonAtomically(ledgerPath, ledger);
  }

  if (result.settings.failed > 0) result.status = 'partial';
  writeJsonAtomically(ledgerPath, ledger);
  return result;
}

module.exports = {
  createDshSettingImporter,
  discoverV1AppData,
  readV1Preferences,
  runV1SettingsImport,
  v1AppDataCandidates,
};
