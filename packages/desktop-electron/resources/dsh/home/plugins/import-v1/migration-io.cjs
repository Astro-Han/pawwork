'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V1_APP_ID = 'ai.pawwork.desktop';
const V1_DATABASE_SUFFIX = ['data', 'pawwork', 'pawwork.db'];
const LEGACY_LEDGER_FIELDS = [
  'credentials',
  'stage1Complete',
  'stage2Complete',
  'stage4DataComplete',
  'workspaceStageComplete',
];

function v1DatabaseCandidates({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  pathApi = platform === 'win32' ? path.win32 : path,
} = {}) {
  let appData;
  if (platform === 'darwin') appData = pathApi.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') appData = env.APPDATA || pathApi.join(home, 'AppData', 'Roaming');
  else return [];
  return [pathApi.join(appData, V1_APP_ID, ...V1_DATABASE_SUFFIX)];
}

function discoverV1Database(options = {}) {
  const env = options.env || process.env;
  const explicit = env.PAWWORK_V1_DATABASE;
  if (explicit && fs.existsSync(explicit)) return explicit;
  return v1DatabaseCandidates(options).find((candidate) => fs.existsSync(candidate)) || null;
}

async function createDatabaseSnapshot(source, destination) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) {
    throw new Error('v1 source and snapshot paths must be absolute');
  }
  if (source === destination) throw new Error('v1 source and snapshot paths must differ');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
  try {
    database.prepare('VACUUM INTO ?').run(destination);
  } finally {
    database.close();
  }
  return destination;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${error.message}`);
  }
}

function requireColumns(database, table, required) {
  const columns = new Set(
    database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
  );
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`unsupported v1 database: ${table} is missing ${missing.join(', ')}`);
  }
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readMigrationLedger(file, fallback) {
  const ledger = readJson(file, fallback);
  if (ledger.schema !== 1) throw new Error(`unsupported v1 migration ledger schema: ${ledger.schema}`);
  for (const field of LEGACY_LEDGER_FIELDS) delete ledger[field];
  return ledger;
}

function writeJsonAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.next`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

module.exports = {
  createDatabaseSnapshot,
  discoverV1Database,
  parseJson,
  readJson,
  readMigrationLedger,
  requireColumns,
  v1DatabaseCandidates,
  writeJsonAtomically,
};
