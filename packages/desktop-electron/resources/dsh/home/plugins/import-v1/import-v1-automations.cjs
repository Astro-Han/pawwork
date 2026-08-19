'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  createDatabaseSnapshot,
  discoverV1Database,
  parseJson,
  readMigrationLedger,
  requireColumns,
  writeJsonAtomically,
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
    const definitions = database.prepare(
      'SELECT * FROM automation_definition ORDER BY time_created, id',
    ).all().map((row) => ({
      id: row.id,
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

function recordCounts() {
  return { imported: 0, skipped: 0, failed: 0 };
}

function emptyResult(sourceDatabase, status) {
  return {
    schema: 1,
    sourceDatabase,
    status,
    definitions: recordCounts(),
    runs: recordCounts(),
    orphanRuns: 0,
    errors: [],
  };
}

async function runV1AutomationImport({
  home,
  sourceDatabase = discoverV1Database(),
  resolveModel,
  importDefinition,
  importRun,
  signal,
  now = () => Date.now(),
}) {
  if (!home || !path.isAbsolute(home)) throw new Error('v1 import home must be absolute');
  if (typeof resolveModel !== 'function') throw new Error('v1 resolveModel adapter is required');
  if (typeof importDefinition !== 'function') throw new Error('v1 importDefinition adapter is required');
  if (typeof importRun !== 'function') throw new Error('v1 importRun adapter is required');
  const directory = path.join(home, 'import-v1');
  const ledgerPath = path.join(directory, 'ledger.json');
  const ledger = readMigrationLedger(ledgerPath, {
    schema: 1,
    sourceDatabase,
    automationDefinitions: {},
    automationRuns: {},
  });
  ledger.automationDefinitions ||= {};
  ledger.automationRuns ||= {};
  if (ledger.sourceDatabase && sourceDatabase && ledger.sourceDatabase !== sourceDatabase) {
    throw new Error(`v1 migration source changed from ${ledger.sourceDatabase} to ${sourceDatabase}`);
  }
  if (!sourceDatabase) {
    const result = emptyResult(null, 'not-found');
    ledger.sourceDatabase = null;
    writeJsonAtomically(ledgerPath, ledger);
    return result;
  }

  fs.mkdirSync(directory, { recursive: true });
  const snapshot = path.join(directory, 'automation-snapshot.db');
  const result = emptyResult(sourceDatabase, 'complete');
  ledger.sourceDatabase = sourceDatabase;
  try {
    signal?.throwIfAborted();
    await createDatabaseSnapshot(sourceDatabase, snapshot);
    const source = readV1Automations(snapshot);
    const definitionIds = new Set(source.definitions.map((definition) => definition.id));
    for (const definition of source.definitions) {
      signal?.throwIfAborted();
      const prior = ledger.automationDefinitions[definition.id];
      if (prior?.status === 'complete') {
        result.definitions.skipped += 1;
        continue;
      }
      try {
        const resolved = await resolveModel(definition);
        const mapped = mapV1AutomationDefinition(definition, resolved);
        const outcome = await importDefinition(mapped);
        if (!['imported', 'skipped'].includes(outcome)) throw new Error(`invalid definition outcome: ${outcome}`);
        result.definitions[outcome] += 1;
        ledger.automationDefinitions[definition.id] = {
          status: 'complete',
          outcome,
          targetId: mapped.id,
          warnings: mapped.migration.warnings,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.definitions.failed += 1;
        result.errors.push({ sourceDefinitionId: definition.id, message });
        ledger.automationDefinitions[definition.id] = { status: 'failed', message };
      }
      writeJsonAtomically(ledgerPath, ledger);
    }

    const completedAt = now();
    for (const run of source.runs) {
      signal?.throwIfAborted();
      const prior = ledger.automationRuns[run.id];
      if (prior?.status === 'complete') {
        result.runs.skipped += 1;
        if (prior.orphanedDefinition) result.orphanRuns += 1;
        continue;
      }
      try {
        const orphanedDefinition = !definitionIds.has(run.automationId);
        const mapped = mapV1AutomationRun(run, { completedAt, orphanedDefinition });
        const outcome = await importRun(mapped);
        if (!['imported', 'skipped'].includes(outcome)) throw new Error(`invalid run outcome: ${outcome}`);
        result.runs[outcome] += 1;
        if (orphanedDefinition) result.orphanRuns += 1;
        ledger.automationRuns[run.id] = {
          status: 'complete',
          outcome,
          targetId: mapped.id,
          orphanedDefinition,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.runs.failed += 1;
        result.errors.push({ sourceRunId: run.id, message });
        ledger.automationRuns[run.id] = { status: 'failed', message };
      }
      writeJsonAtomically(ledgerPath, ledger);
    }
    if (result.definitions.failed > 0 || result.runs.failed > 0) result.status = 'partial';
    writeJsonAtomically(ledgerPath, ledger);
    return result;
  } finally {
    fs.rmSync(snapshot, { force: true });
    fs.rmSync(`${snapshot}-shm`, { force: true });
    fs.rmSync(`${snapshot}-wal`, { force: true });
  }
}

module.exports = {
  mapV1AutomationDefinition,
  mapV1AutomationRun,
  readV1Automations,
  runV1AutomationImport,
  v2AutomationId,
};
