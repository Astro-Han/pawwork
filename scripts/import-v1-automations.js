'use strict';
const { DatabaseSync } = require('node:sqlite');

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

function readV1Automations(snapshot) {
  const database = new DatabaseSync(snapshot, { readOnly: true, timeout: 5_000 });
  try {
    requireColumns(database, 'automation_definition', [
      'id', 'project_id', 'owner_directory', 'time_created', 'time_updated', 'data',
    ]);
    requireColumns(database, 'automation_run', [
      'id', 'automation_id', 'project_id', 'owner_directory', 'triggered_at', 'data',
    ]);
    const definitions = database.prepare(
      'SELECT * FROM automation_definition ORDER BY time_created, id',
    ).all().map((row) => ({
      id: row.id,
      projectId: row.project_id,
      ownerDirectory: row.owner_directory,
      createdAt: row.time_created,
      updatedAt: row.time_updated,
      data: parseJson(row.data, `automation definition ${row.id}`),
    }));
    const runs = database.prepare(
      'SELECT * FROM automation_run ORDER BY triggered_at, id',
    ).all().map((row) => ({
      id: row.id,
      automationId: row.automation_id,
      projectId: row.project_id,
      ownerDirectory: row.owner_directory,
      triggeredAt: row.triggered_at,
      data: parseJson(row.data, `automation run ${row.id}`),
    }));
    return { definitions, runs };
  } finally {
    database.close();
  }
}

function v2AutomationId(sourceId) {
  return `pawwork-v1-${sourceId}`;
}

function v2SessionId(sourceId) {
  return `pawwork-v1-${sourceId}`;
}

function mapV1AutomationDefinition(source, { model, modelWarning } = {}) {
  const definition = source.data;
  if (!definition || definition.id !== source.id) throw new Error(`invalid v1 automation definition: ${source.id}`);
  if (!model?.provider || !model?.model) throw new Error('resolved v2 automation model is required');
  const warnings = [];
  if (modelWarning) warnings.push(modelWarning);
  if (definition.where?.worktree) warnings.push('worktree_placement_not_preserved');
  if (definition.variant) warnings.push('reasoning_effort_not_preserved');
  const context = definition.context === 'continue' ? 'continue' : 'fresh';
  if (context === 'continue' && !definition.sourceSessionID) {
    throw new Error(`v1 continue automation ${source.id} has no source session`);
  }
  const common = {
    id: v2AutomationId(source.id),
    title: definition.title,
    prompt: definition.prompt,
    revision: Math.max(1, definition.revision || 1),
    paused: true,
    context,
    cwd: source.ownerDirectory,
    model: { provider: model.provider, model: model.model },
    timezone: definition.timezone || 'UTC',
    ...(context === 'continue' ? { sourceSessionId: v2SessionId(definition.sourceSessionID) } : {}),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    migration: {
      source: 'pawwork-v1',
      sourceId: source.id,
      takeover: definition.paused ? 'not_required' : 'pending',
      warnings,
    },
  };
  if (definition.kind === 'oneshot') {
    return { ...common, kind: 'oneshot', fireAt: definition.fireAt, nextFireAt: null };
  }
  if (definition.kind !== 'recurring') throw new Error(`unsupported v1 automation kind: ${definition.kind}`);
  if (!['interval', 'cron'].includes(definition.rhythm?.kind)) {
    throw new Error(`unsupported v1 automation rhythm: ${definition.rhythm?.kind}`);
  }
  if (!['never', 'count'].includes(definition.stop?.kind)) {
    throw new Error(`unsupported v1 automation stop: ${definition.stop?.kind}`);
  }
  return {
    ...common,
    kind: 'recurring',
    rhythm: structuredClone(definition.rhythm),
    stop: structuredClone(definition.stop),
    nextFireAt: null,
  };
}

function runError(error) {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string') {
    return typeof error.code === 'string' ? `${error.code}: ${error.message}` : error.message;
  }
  return 'v1 automation run failed';
}

function mapV1AutomationRun(source, { completedAt = Date.now() } = {}) {
  const run = source.data;
  if (!run || run.id !== source.id) throw new Error(`invalid v1 automation run: ${source.id}`);
  const common = {
    id: v2AutomationId(source.id),
    automationId: v2AutomationId(source.automationId),
    definitionRevision: Math.max(1, run.definitionRevision || 1),
    triggeredAt: run.triggeredAt ?? source.triggeredAt,
    startedAt: run.startedAt ?? null,
    sessionId: run.sessionID ? v2SessionId(run.sessionID) : null,
    result: null,
    error: null,
    stopReason: null,
    migration: {
      source: 'pawwork-v1',
      sourceId: source.id,
      sourceState: run.state,
      ...(run.cost == null ? {} : { cost: run.cost }),
    },
  };
  if (run.state === 'succeeded') {
    return { ...common, state: 'succeeded', completedAt: run.completedAt, result: run.result ?? null };
  }
  if (run.state === 'failed') {
    return { ...common, state: 'failed', completedAt: run.completedAt, error: runError(run.error) };
  }
  if (run.state === 'stopped') {
    return { ...common, state: 'stopped', completedAt: run.completedAt, stopReason: run.stopReason || 'stopped' };
  }
  if (['scheduled', 'running', 'awaiting_input'].includes(run.state)) {
    return { ...common, state: 'stopped', completedAt, stopReason: 'interrupted' };
  }
  throw new Error(`unsupported v1 automation run state: ${run.state}`);
}

module.exports = {
  mapV1AutomationDefinition,
  mapV1AutomationRun,
  readV1Automations,
  v2AutomationId,
};
