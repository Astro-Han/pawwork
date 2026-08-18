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

const INTERNAL_PART_TYPES = new Set(['step-start', 'step-finish', 'snapshot', 'patch', 'compaction']);

function dshSessionId(sourceSessionId) {
  return `pawwork-v1-${sourceSessionId}`;
}

function sessionWorkingDirectory(session) {
  const active = session.executionContext?.activeDirectory;
  return typeof active === 'string' && active ? active : session.directory;
}

function legacyAttachment(part) {
  const data = part.data;
  return {
    type: 'pawwork-v1-attachment',
    id: part.id,
    createdAt: part.createdAt,
    updatedAt: part.updatedAt,
    mime: data.mime,
    ...(data.filename === undefined ? {} : { filename: data.filename }),
    url: data.url,
    ...(data.source === undefined ? {} : { source: data.source }),
    ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
  };
}

function legacyTool(part) {
  return {
    type: 'pawwork-v1-tool',
    id: part.id,
    createdAt: part.createdAt,
    updatedAt: part.updatedAt,
    callId: part.data.callID,
    tool: part.data.tool,
    state: part.data.state,
    ...(part.data.metadata === undefined ? {} : { metadata: part.data.metadata }),
  };
}

function mapPart(part) {
  const data = part.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.type !== 'string') {
    return { kind: 'unsupported', block: { type: 'pawwork-v1-part', id: part.id, data } };
  }
  if (data.type === 'text' && typeof data.text === 'string') {
    return { kind: 'native', block: { type: 'text', text: data.text } };
  }
  if (data.type === 'reasoning' && typeof data.text === 'string') {
    return { kind: 'native', block: { type: 'reasoning', text: data.text } };
  }
  if (data.type === 'file' && typeof data.mime === 'string' && typeof data.url === 'string') {
    return { kind: 'legacy', block: legacyAttachment(part) };
  }
  if (data.type === 'tool' && typeof data.tool === 'string' && data.state) {
    return { kind: 'legacy', block: legacyTool(part) };
  }
  if (INTERNAL_PART_TYPES.has(data.type)) return { kind: 'skipped' };
  return {
    kind: 'unsupported',
    block: {
      type: 'pawwork-v1-part',
      id: part.id,
      createdAt: part.createdAt,
      updatedAt: part.updatedAt,
      partType: data.type,
      data,
    },
  };
}

function buildDshSession(session) {
  const seed = [];
  const stats = {
    messages: session.messages.length,
    parts: 0,
    skippedParts: 0,
    unsupportedParts: 0,
  };
  const append = (type, time, data, extra = {}) => {
    seed.push({ type, seq: seed.length, time, data, ...extra });
  };

  append('pawwork-v1/session', session.createdAt, {
    schema: 1,
    sourceSessionId: session.id,
    projectId: session.projectId,
    workspaceId: session.workspaceId,
    parentId: session.parentId,
    directory: session.directory,
    executionContext: session.executionContext,
    title: session.title,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
  }, { ignorable: true });

  let turn = 0;
  let step = 0;
  let turnOpen = false;
  let lastTime = session.createdAt;
  const closeTurn = () => {
    if (!turnOpen) return;
    append('turn/end', lastTime, { turn, reason: { kind: 'completed' } });
    turnOpen = false;
  };
  const openTurn = (time) => {
    turn += 1;
    step = 0;
    turnOpen = true;
    lastTime = time;
    append('turn/start', time, { turn });
  };

  for (const message of session.messages) {
    const role = message.data?.role;
    if (role === 'user') {
      closeTurn();
      openTurn(message.createdAt);
    } else if (role === 'assistant' && !turnOpen) {
      openTurn(message.createdAt);
    }

    const content = [];
    const skippedParts = [];
    for (const part of message.parts) {
      stats.parts += 1;
      const mapped = mapPart(part);
      if (mapped.kind === 'skipped') {
        stats.skippedParts += 1;
        skippedParts.push(part);
      } else {
        if (mapped.kind === 'unsupported') stats.unsupportedParts += 1;
        content.push(mapped.block);
      }
    }
    append('pawwork-v1/message', message.createdAt, {
      schema: 1,
      sourceMessageId: message.id,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      data: message.data,
      skippedParts,
    }, { ignorable: true });

    if (role === 'user') {
      append('user/message', message.createdAt, {
        id: message.id,
        role: 'user',
        content,
        source: { kind: 'user' },
      }, { surfaceOp: 'append' });
      lastTime = Math.max(lastTime, message.updatedAt);
      continue;
    }

    if (role === 'assistant') {
      step += 1;
      append('step/start', message.createdAt, { turn, step });
      const completedAt = message.data.time?.completed ?? message.updatedAt;
      append('assistant/message', completedAt, {
        turn,
        step,
        message: {
          id: message.id,
          role: 'assistant',
          content,
          source: {
            kind: 'model',
            provider: message.data.providerID || 'pawwork-v1',
            model: message.data.modelID || 'unknown',
          },
        },
      }, { surfaceOp: 'append' });
      append('step/end', completedAt, { turn, step });
      lastTime = Math.max(lastTime, completedAt);
      continue;
    }

    stats.unsupportedParts += message.parts.length;
    lastTime = Math.max(lastTime, message.updatedAt);
  }
  closeTurn();

  const meta = {
    cwd: sessionWorkingDirectory(session),
    createdAt: session.createdAt,
    seedLength: seed.length,
    ...(session.parentId ? { parentSession: dshSessionId(session.parentId) } : {}),
  };
  return {
    id: dshSessionId(session.id),
    title: session.title,
    seed,
    meta,
    stats,
  };
}

module.exports = {
  buildDshSession,
  createDatabaseSnapshot,
  discoverV1Database,
  readV1Sessions,
  v1DatabaseCandidates,
};
