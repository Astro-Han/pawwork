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

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${error.message}`);
  }
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function requireColumns(database, table, required) {
  const columns = tableColumns(database, table);
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`unsupported v1 database: ${table} is missing ${missing.join(', ')}`);
  }
}

async function* readV1Sessions(snapshot) {
  const database = new DatabaseSync(snapshot, { readOnly: true, timeout: 5_000 });
  try {
    requireColumns(database, 'session', ['id', 'project_id', 'directory', 'title', 'version', 'time_created', 'time_updated']);
    requireColumns(database, 'message', ['id', 'session_id', 'time_created', 'time_updated', 'data']);
    requireColumns(database, 'part', ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data']);

    const sessions = database.prepare('SELECT * FROM session ORDER BY time_created, id').all();
    const messagesForSession = database.prepare(
      'SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id',
    );
    const partsForSession = database.prepare(
      'SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id',
    );

    for (const session of sessions) {
      const partsByMessage = new Map();
      for (const part of partsForSession.all(session.id)) {
        const normalized = {
          id: part.id,
          createdAt: part.time_created,
          updatedAt: part.time_updated,
          data: parseJson(part.data, `part ${part.id}`),
        };
        const messageParts = partsByMessage.get(part.message_id);
        if (messageParts) messageParts.push(normalized);
        else partsByMessage.set(part.message_id, [normalized]);
      }

      const messages = messagesForSession.all(session.id).map((message) => ({
        id: message.id,
        createdAt: message.time_created,
        updatedAt: message.time_updated,
        data: parseJson(message.data, `message ${message.id}`),
        parts: partsByMessage.get(message.id) || [],
      }));
      yield {
        id: session.id,
        projectId: session.project_id,
        workspaceId: session.workspace_id ?? null,
        parentId: session.parent_id ?? null,
        directory: session.directory,
        executionContext: session.execution_context == null
          ? null
          : parseJson(session.execution_context, `session ${session.id} execution_context`),
        title: session.title,
        version: session.version,
        createdAt: session.time_created,
        updatedAt: session.time_updated,
        archivedAt: session.time_archived ?? null,
        messages,
      };
    }
  } finally {
    database.close();
  }
}

module.exports = {
  createDatabaseSnapshot,
  discoverV1Database,
  readV1Sessions,
  v1DatabaseCandidates,
};
