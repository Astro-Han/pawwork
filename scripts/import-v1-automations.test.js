'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  mapV1AutomationDefinition,
  mapV1AutomationRun,
  readV1Automations,
} = require('./import-v1-automations');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-v1-automations-'));
  const file = path.join(root, 'pawwork.db');
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE automation_definition (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_directory TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE automation_run (
      id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, project_id TEXT NOT NULL,
      owner_directory TEXT NOT NULL, triggered_at INTEGER NOT NULL, data TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
  `);
  const definition = {
    id: 'automation_source',
    title: 'Daily brief',
    prompt: 'Write the brief.',
    revision: 3,
    paused: false,
    context: 'continue',
    sourceSessionID: 'ses_source',
    where: { projectID: 'project_1', worktree: 'daily-brief' },
    createdAt: 1_000,
    updatedAt: 2_000,
    timezone: 'Asia/Shanghai',
    model: { providerID: 'openai', modelID: 'gpt-5.5' },
    variant: 'medium',
    kind: 'recurring',
    rhythm: { kind: 'cron', expression: '0 9 * * 1-5' },
    stop: { kind: 'count', count: 4 },
    nextFireAt: 9_000,
    nextFires: [9_000],
    failureStreak: 0,
    normalizationWarnings: [],
  };
  database.prepare('INSERT INTO automation_definition VALUES (?, ?, ?, ?, ?, ?)').run(
    definition.id,
    'project_1',
    '/Users/alice/work',
    1_000,
    2_000,
    JSON.stringify(definition),
  );
  const insertRun = database.prepare('INSERT INTO automation_run VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertRun.run(
    'automation_run_done', definition.id, 'project_1', '/Users/alice/work', 3_000,
    JSON.stringify({
      id: 'automation_run_done', automationID: definition.id, revision: 1,
      definitionRevision: 2, state: 'succeeded', triggeredAt: 3_000,
      startedAt: 3_100, completedAt: 3_500, sessionID: 'ses_run', result: 'Done', error: null, cost: 0.1,
    }),
    3_000, 3_500,
  );
  insertRun.run(
    'automation_run_live', definition.id, 'project_1', '/Users/alice/work', 4_000,
    JSON.stringify({
      id: 'automation_run_live', automationID: definition.id, revision: 2,
      definitionRevision: 3, state: 'awaiting_input', triggeredAt: 4_000,
      startedAt: 4_100, completedAt: null, sessionID: 'ses_live', result: null, error: null, cost: null,
      blocker: { kind: 'question', callID: 'call_1' },
    }),
    4_000, 4_100,
  );
  database.close();
  return file;
}

test('reads v1 automation definitions and runs from their authoritative tables', () => {
  const source = fixture();
  const data = readV1Automations(source);

  assert.equal(data.definitions.length, 1);
  assert.equal(data.definitions[0].ownerDirectory, '/Users/alice/work');
  assert.equal(data.definitions[0].data.rhythm.expression, '0 9 * * 1-5');
  assert.deepEqual(data.runs.map((run) => run.id), ['automation_run_done', 'automation_run_live']);
});

test('maps v1 definitions into paused v2-owned records pending one takeover', () => {
  const source = readV1Automations(fixture()).definitions[0];
  const mapped = mapV1AutomationDefinition(source, {
    model: { provider: 'opencode', model: 'big-pickle' },
    modelWarning: 'model_not_available',
  });

  assert.equal(mapped.id, 'pawwork-v1-automation_source');
  assert.equal(mapped.paused, true);
  assert.equal(mapped.context, 'continue');
  assert.equal(mapped.sourceSessionId, 'pawwork-v1-ses_source');
  assert.deepEqual(mapped.rhythm, { kind: 'cron', expression: '0 9 * * 1-5' });
  assert.deepEqual(mapped.stop, { kind: 'count', count: 4 });
  assert.equal(mapped.nextFireAt, null);
  assert.deepEqual(mapped.migration, {
    source: 'pawwork-v1',
    sourceId: 'automation_source',
    takeover: 'pending',
    warnings: ['model_not_available', 'worktree_placement_not_preserved', 'reasoning_effort_not_preserved'],
  });
});

test('maps completed history and turns in-flight v1 runs into interrupted history', () => {
  const data = readV1Automations(fixture());
  const completed = mapV1AutomationRun(data.runs[0], { completedAt: 8_000 });
  const interrupted = mapV1AutomationRun(data.runs[1], { completedAt: 8_000 });

  assert.equal(completed.id, 'pawwork-v1-automation_run_done');
  assert.equal(completed.automationId, 'pawwork-v1-automation_source');
  assert.equal(completed.sessionId, 'pawwork-v1-ses_run');
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result, 'Done');
  assert.equal(interrupted.state, 'stopped');
  assert.equal(interrupted.stopReason, 'interrupted');
  assert.equal(interrupted.completedAt, 8_000);
  assert.equal(interrupted.sessionId, 'pawwork-v1-ses_live');
});
