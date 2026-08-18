'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backup, DatabaseSync } = require('node:sqlite');

const V1_APP_ID = 'ai.pawwork.desktop';
const V1_DATABASE_SUFFIX = ['data', 'pawwork', 'pawwork.db'];

function v1DatabaseCandidates({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  pathApi = platform === 'win32' ? path.win32 : path,
} = {}) {
  let appData;
  if (platform === 'darwin') {
    appData = pathApi.join(home, 'Library', 'Application Support');
  } else if (platform === 'win32') {
    appData = env.APPDATA || pathApi.join(home, 'AppData', 'Roaming');
  } else {
    return [];
  }
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
  const database = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
  try {
    await backup(database, destination);
  } finally {
    database.close();
  }
  return destination;
}

module.exports = {
  createDatabaseSnapshot,
  discoverV1Database,
  v1DatabaseCandidates,
};
