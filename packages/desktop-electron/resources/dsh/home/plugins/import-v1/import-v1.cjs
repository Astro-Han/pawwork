'use strict';
const { DatabaseSync } = require('node:sqlite');
const {
  discoverV1Database,
  guardV1DatabaseIdentity,
  openMigrationLedger,
  parseJson,
  requireColumns,
} = require('./migration-io.cjs');

async function* readV1Sessions(snapshot) {
  const database = new DatabaseSync(snapshot, { readOnly: true, timeout: 5_000 });
  try {
    requireColumns(database, 'session', ['id', 'directory', 'title', 'version', 'time_created', 'time_updated']);
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
      try {
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
        const executionContext = session.execution_context == null
          ? null
          : parseJson(session.execution_context, `session ${session.id} execution_context`);
        yield {
          id: session.id,
          parentId: session.parent_id ?? null,
          cwd: typeof executionContext?.activeDirectory === 'string' && executionContext.activeDirectory
            ? executionContext.activeDirectory
            : session.directory,
          title: session.title,
          version: session.version,
          createdAt: session.time_created,
          updatedAt: session.time_updated,
          archivedAt: session.time_archived ?? null,
          messages,
        };
      } catch (error) {
        yield {
          id: session.id,
          readError: error instanceof Error ? error.message : String(error),
        };
      }
    }
  } finally {
    database.close();
  }
}

const INTERNAL_PART_TYPES = new Set(['step-start', 'step-finish', 'snapshot', 'patch', 'compaction']);
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_ADMISSION_ERRORS = new Set([
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE_BASE64',
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
]);

function dshSessionId(sourceSessionId) {
  return `pawwork-v1-${sourceSessionId}`;
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
    version: session.version,
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
    cwd: session.cwd,
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

async function attachDshWorkspace(imported, workspaceRegistry) {
  try {
    const workspace = await workspaceRegistry.create(imported.meta.cwd);
    await workspace.attachSession(imported.id);
    return 'attached';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'unavailable';
    throw error;
  }
}

async function materializeLegacyImages(imported, saveImage) {
  for (const event of imported.seed) {
    const content = event.type === 'user/message'
      ? event.data.content
      : event.type === 'assistant/message'
        ? event.data.message.content
        : null;
    if (!Array.isArray(content)) continue;

    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      if (block.type !== 'pawwork-v1-attachment' || !IMAGE_MEDIA_TYPES.has(block.mime)) continue;
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(block.url);
      if (!match || match[1] !== block.mime) continue;
      try {
        const attachment = await saveImage({
          data: Buffer.from(match[2], 'base64'),
          mediaType: block.mime,
          ...(block.filename ? { name: block.filename } : {}),
        });
        content[index] = { type: 'image', attachment };
      } catch (error) {
        if (!IMAGE_ADMISSION_ERRORS.has(error?.code)) throw error;
        if (imported.stats) imported.stats.unsupportedParts += 1;
      }
    }
  }
  return imported;
}

async function runV1SessionImport({
  home,
  sourceDatabase = discoverV1Database(),
  snapshot,
  importSession,
  signal,
}) {
  if (typeof importSession !== 'function') throw new Error('v1 importSession adapter is required');
  const { ledger, save } = openMigrationLedger(home);
  guardV1DatabaseIdentity(ledger, sourceDatabase);
  if (!sourceDatabase) {
    save();
    return;
  }

  if (!snapshot) throw new Error('v1 session import requires a database snapshot');
  signal?.throwIfAborted();
  for await (const sourceSession of readV1Sessions(snapshot)) {
    signal?.throwIfAborted();
    if (sourceSession.readError) {
      ledger.sessions[sourceSession.id] = { status: 'failed', message: sourceSession.readError };
      save();
      continue;
    }
    const imported = buildDshSession(sourceSession);
    const previous = ledger.sessions[sourceSession.id];
    const alreadyImported = previous?.status === 'complete';
    if (alreadyImported && (previous.workspaceAttached === true || previous.workspaceUnavailable === true)) {
      continue;
    }
    try {
      const workspaceOutcome = await importSession(imported, { contentImported: alreadyImported });
      signal?.throwIfAborted();
      if (!['attached', 'unavailable'].includes(workspaceOutcome)) throw new Error(`invalid workspace outcome: ${workspaceOutcome}`);
      ledger.sessions[sourceSession.id] = {
        ...previous,
        status: 'complete',
        targetId: imported.id,
        stats: imported.stats,
        workspaceAttached: workspaceOutcome === 'attached',
        workspaceUnavailable: workspaceOutcome === 'unavailable',
      };
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      ledger.sessions[sourceSession.id] = alreadyImported
        ? { ...previous, workspaceAttached: false, workspaceMessage: message }
        : { status: 'failed', targetId: imported.id, message };
    }
    save();
  }
  save();
}

function completedV1SessionTargetIds(home) {
  const { ledger } = openMigrationLedger(home);
  return new Set(Object.values(ledger.sessions)
    .filter((entry) => entry?.status === 'complete' && typeof entry.targetId === 'string')
    .map((entry) => entry.targetId));
}

module.exports = {
  attachDshWorkspace,
  buildDshSession,
  completedV1SessionTargetIds,
  materializeLegacyImages,
  readV1Sessions,
  runV1SessionImport,
};
