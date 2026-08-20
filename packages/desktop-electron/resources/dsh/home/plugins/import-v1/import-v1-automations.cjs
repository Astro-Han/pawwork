'use strict';
const { DatabaseSync } = require('node:sqlite');
const {
  discoverV1Database,
  guardV1DatabaseIdentity,
  openMigrationLedger,
  parseJson,
  requireColumns,
} = require('./migration-io.cjs');

function readV1Automations(snapshot) {
  const database = new DatabaseSync(snapshot, { readOnly: true, timeout: 5_000 });
  try {
    requireColumns(database, 'automation_definition', [
      'id', 'owner_directory', 'time_created', 'time_updated', 'data',
    ]);
    requireColumns(database, 'automation_run', [
      'id', 'automation_id', 'owner_directory', 'triggered_at', 'data',
    ]);
    const definitionRows = database.prepare(
      'SELECT * FROM automation_definition ORDER BY time_created, id',
    ).all();
    const runRows = database.prepare(
      'SELECT * FROM automation_run ORDER BY triggered_at, id',
    ).all();
    const definitions = [];
    const runs = [];
    const failures = [];
    for (const row of definitionRows) {
      try {
        definitions.push({
          id: row.id,
          ownerDirectory: row.owner_directory,
          createdAt: row.time_created,
          updatedAt: row.time_updated,
          data: parseJson(row.data, `automation definition ${row.id}`),
        });
      } catch (error) {
        failures.push({ kind: 'definition', id: row.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const row of runRows) {
      try {
        runs.push({
          id: row.id,
          automationId: row.automation_id,
          ownerDirectory: row.owner_directory,
          triggeredAt: row.triggered_at,
          data: parseJson(row.data, `automation run ${row.id}`),
        });
      } catch (error) {
        failures.push({ kind: 'run', id: row.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { definitions, runs, failures, definitionIds: definitions.map((definition) => definition.id) };
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
    paused: Boolean(definition.paused),
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
      warnings,
    },
  };
  if (definition.kind === 'oneshot') {
    return { ...common, kind: 'oneshot', fireAt: definition.fireAt };
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
  };
}

function runError(error) {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string') {
    return typeof error.code === 'string' ? `${error.code}: ${error.message}` : error.message;
  }
  return 'v1 automation run failed';
}

function mapV1AutomationRun(source, { completedAt = Date.now(), orphanedDefinition = false } = {}) {
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
      ...(orphanedDefinition ? { orphanedDefinition: true } : {}),
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

async function runV1AutomationImport({
  home,
  sourceDatabase = discoverV1Database(),
  snapshot,
  resolveModel,
  importDefinition,
  importRun,
  signal,
  now = () => Date.now(),
}) {
  if (typeof resolveModel !== 'function') throw new Error('v1 resolveModel adapter is required');
  if (typeof importDefinition !== 'function') throw new Error('v1 importDefinition adapter is required');
  if (typeof importRun !== 'function') throw new Error('v1 importRun adapter is required');
  const { ledger, save } = openMigrationLedger(home);
  guardV1DatabaseIdentity(ledger, sourceDatabase);
  if (!sourceDatabase) {
    await save();
    return;
  }

  if (!snapshot) throw new Error('v1 automation import requires a database snapshot');
  signal?.throwIfAborted();
  const source = readV1Automations(snapshot);
  const definitionIds = new Set(source.definitionIds);
  for (const failure of source.failures) {
    const records = failure.kind === 'definition'
      ? ledger.failures.automationDefinitions
      : ledger.failures.automationRuns;
    records[failure.id] = { message: failure.message };
  }
  if (source.failures.length > 0) await save();
  for (const definition of source.definitions) {
    signal?.throwIfAborted();
    try {
      const resolved = await resolveModel(definition);
      signal?.throwIfAborted();
      const mapped = mapV1AutomationDefinition(definition, resolved);
      const outcome = await importDefinition(mapped);
      signal?.throwIfAborted();
      if (!['imported', 'skipped'].includes(outcome)) throw new Error(`invalid definition outcome: ${outcome}`);
      delete ledger.failures.automationDefinitions[definition.id];
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      ledger.failures.automationDefinitions[definition.id] = { message };
    }
    await save();
  }

  const completedAt = now();
  for (const run of source.runs) {
    signal?.throwIfAborted();
    try {
      const orphanedDefinition = !definitionIds.has(run.automationId);
      const mapped = mapV1AutomationRun(run, { completedAt, orphanedDefinition });
      const outcome = await importRun(mapped);
      signal?.throwIfAborted();
      if (!['imported', 'skipped'].includes(outcome)) throw new Error(`invalid run outcome: ${outcome}`);
      delete ledger.failures.automationRuns[run.id];
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      ledger.failures.automationRuns[run.id] = { message };
    }
    await save();
  }
  await save();
}

module.exports = {
  mapV1AutomationDefinition,
  mapV1AutomationRun,
  readV1Automations,
  runV1AutomationImport,
};
