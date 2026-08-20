'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V1_APP_ID = 'ai.pawwork.desktop';

// One fact, stated once: where v1 kept this user's data. The database stage and
// the settings stage differ only by what they append to it — before, each owned
// a copy of the platform branch and returned a list that never held more than
// one entry.
function v1DataPath({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  pathApi = platform === 'win32' ? path.win32 : path,
} = {}, ...segments) {
  if (platform === 'darwin') {
    return pathApi.join(home, 'Library', 'Application Support', V1_APP_ID, ...segments);
  }
  if (platform === 'win32') {
    const roaming = env.APPDATA || pathApi.join(home, 'AppData', 'Roaming');
    return pathApi.join(roaming, V1_APP_ID, ...segments);
  }
  return null;
}

function discoverExisting(explicit, official) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  return official && fs.existsSync(official) ? official : null;
}

function discoverV1Database(options = {}) {
  const env = options.env || process.env;
  return discoverExisting(env.PAWWORK_V1_DATABASE, v1DataPath(options, 'data', 'pawwork', 'pawwork.db'));
}

function discoverV1AppData(options = {}) {
  const env = options.env || process.env;
  return discoverExisting(env.PAWWORK_V1_APP_DATA, v1DataPath(options));
}

async function createDatabaseSnapshot(source, destination) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) {
    throw new Error('v1 source and snapshot paths must be absolute');
  }
  if (source === destination) throw new Error('v1 source and snapshot paths must differ');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  for (const file of [destination, `${destination}-shm`, `${destination}-wal`]) {
    fs.rmSync(file, { force: true });
  }
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
  try {
    database.prepare('VACUUM INTO ?').run(destination);
  } finally {
    database.close();
  }
  fs.chmodSync(destination, 0o600);
  return destination;
}

// One import run reads the v1 database in two stages, sessions and automations.
// Each used to VACUUM the whole database into its own private copy, so the first
// launch after an upgrade copied everything the user had twice. The snapshot is a
// property of the run rather than of a stage: open it once here and hand both
// stages the path.
async function openV1Snapshot({ home, sourceDatabase }) {
  if (!home || !path.isAbsolute(home)) throw new Error('v1 import home must be absolute');
  const file = path.join(home, 'import-v1', 'snapshot.db');
  await createDatabaseSnapshot(sourceDatabase, file);
  return {
    path: file,
    close() {
      for (const stale of [file, `${file}-shm`, `${file}-wal`]) fs.rmSync(stale, { force: true });
    },
  };
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
  return ledger;
}

// The three stages and the ledger reader all opened the same file themselves:
// four copies of the absolute-home guard (one of which silently returned an empty
// result instead of throwing), four path constructions, four reads, and four
// hand-seeded table sets. The ledger has one owner now; the stages say only what
// they record in it.
function openMigrationLedger(home) {
  if (!home || !path.isAbsolute(home)) throw new Error('v1 import home must be absolute');
  const file = path.join(home, 'import-v1', 'ledger.json');
  const ledger = readMigrationLedger(file, { schema: 1 });
  ledger.sessions ||= {};
  ledger.settings ||= {};
  ledger.automationDefinitions ||= {};
  ledger.automationRuns ||= {};
  return { ledger, save: () => writeJsonAtomically(file, ledger) };
}

// The session and automation stages read one database and record one identity,
// so this guard was byte-for-byte the same in both. The settings stage tracks a
// different source under a different key and states its own.
function guardV1DatabaseIdentity(ledger, sourceDatabase) {
  if (ledger.sourceDatabase && sourceDatabase && ledger.sourceDatabase !== sourceDatabase) {
    throw new Error(`v1 migration source changed from ${ledger.sourceDatabase} to ${sourceDatabase}`);
  }
  ledger.sourceDatabase = sourceDatabase || null;
}

function writeJsonAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.next`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

module.exports = {
  createDatabaseSnapshot,
  discoverV1AppData,
  discoverV1Database,
  guardV1DatabaseIdentity,
  openMigrationLedger,
  openV1Snapshot,
  parseJson,
  readJson,
  requireColumns,
  v1DataPath,
};
